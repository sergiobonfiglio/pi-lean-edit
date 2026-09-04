import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { observeToolResult, toolResultObserverInternals } from "../src/tool-result-observer.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-observer-"));
}

function event(overrides: Partial<ToolResultEvent> & Pick<ToolResultEvent, "toolName">): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call",
    input: {},
    content: [],
    details: undefined,
    isError: false,
    ...overrides
  } as ToolResultEvent;
}

test("grep marker parsing recognizes matches and context", () => {
  assert.deepEqual(toolResultObserverInternals.markerCandidates("src/a.ts:12: match"), [
    { displayPath: "src/a.ts", line: 12, text: "match" }
  ]);
  assert.deepEqual(toolResultObserverInternals.markerCandidates("src/a-file.ts-11- context"), [
    { displayPath: "src/a-file.ts", line: 11, text: "context" }
  ]);
});

test("grep results snapshot verified match and context lines from multiple files", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, "nested"));
  const firstPath = path.join(dir, "a.txt");
  const secondPath = path.join(dir, "nested", "b-file.txt");
  await fs.writeFile(firstPath, "alpha\nneedle:42: exact\nomega\n", "utf8");
  await fs.writeFile(secondPath, "before\nsecond needle\nafter\n", "utf8");
  const first = await fs.realpath(firstPath);
  const second = await fs.realpath(secondPath);
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "grep",
    input: { pattern: "needle", path: dir, context: 1 },
    content: [{ type: "text", text: [
      "a.txt-1- alpha",
      "a.txt:2: needle:42: exact",
      "a.txt-3- omega",
      "nested/b-file.txt-1- before",
      "nested/b-file.txt:2: second needle",
      "nested/b-file.txt-3- after"
    ].join("\n") }]
  }), dir, store);

  assert.deepEqual(store.covered(first, 1, 3)?.lines, ["alpha", "needle:42: exact", "omega"]);
  assert.deepEqual(store.covered(second, 1, 3)?.lines, ["before", "second needle", "after"]);
});

test("grep of one file resolves the basename emitted by the built-in tool", async () => {
  const dir = await tempDir();
  const rawFile = path.join(dir, "odd:7-file.txt");
  await fs.writeFile(rawFile, "match\n", "utf8");
  const file = await fs.realpath(rawFile);
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "grep",
    input: { pattern: "match", path: file },
    content: [{ type: "text", text: "odd:7-file.txt:1: match" }]
  }), dir, store);

  assert.deepEqual(store.covered(file, 1, 1)?.lines, ["match"]);
});

test("grep ignores no-match, malformed, mismatched, image, and truncated results", async (t) => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "alpha\nneedle\n", "utf8");

  const cases: Array<{ name: string; result: ToolResultEvent }> = [
    { name: "no matches", result: event({ toolName: "grep", input: { path: dir }, content: [{ type: "text", text: "No matches found" }] }) },
    { name: "malformed row", result: event({ toolName: "grep", input: { path: dir }, content: [{ type: "text", text: "a.txt:2: needle\nnot a grep row" }] }) },
    { name: "changed line", result: event({ toolName: "grep", input: { path: dir }, content: [{ type: "text", text: "a.txt:2: old value" }] }) },
    { name: "image", result: event({ toolName: "grep", input: { path: dir }, content: [{ type: "text", text: "a.txt:2: needle" }, { type: "image", data: "", mimeType: "image/png" }] }) },
    { name: "long line truncation", result: event({ toolName: "grep", input: { path: dir }, content: [{ type: "text", text: "a.txt:2: needle" }], details: { linesTruncated: true } }) },
    { name: "byte truncation", result: event({ toolName: "grep", input: { path: dir }, content: [{ type: "text", text: "a.txt:2: needle" }], details: { truncation: { truncated: true } } }) }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const store = new SnapshotStore();
      await observeToolResult(item.result, dir, store);
      assert.equal(store.covered(file, 2, 2), undefined);
    });
  }
});

test("a delayed grep observation cannot restore snapshots cleared by a newer event", async () => {
  const dir = await tempDir();
  const rawFile = path.join(dir, "a.txt");
  await fs.writeFile(rawFile, "needle\n", "utf8");
  const file = await fs.realpath(rawFile);
  const store = new SnapshotStore();
  store.set({ path: file, startLine: 1, endLine: 1, lines: ["old"] });

  const pending = observeToolResult(event({
    toolName: "grep",
    input: { pattern: "needle", path: dir },
    content: [{ type: "text", text: "a.txt:1: needle" }]
  }), dir, store);
  store.clear(file);
  await pending;

  assert.equal(store.covered(file, 1, 1), undefined);
});


test("failed mutations do nothing and successful edit/write clear only their target", async () => {
  const dir = await tempDir();
  const firstPath = path.join(dir, "a.txt");
  const secondPath = path.join(dir, "b.txt");
  await fs.writeFile(firstPath, "a\n", "utf8");
  await fs.writeFile(secondPath, "b\n", "utf8");
  const first = await fs.realpath(firstPath);
  const second = await fs.realpath(secondPath);
  const store = new SnapshotStore();
  store.set({ path: first, startLine: 1, endLine: 1, lines: ["a"] });
  store.set({ path: second, startLine: 1, endLine: 1, lines: ["b"] });

  await observeToolResult(event({ toolName: "edit", input: { path: first }, isError: true }), dir, store);
  assert.deepEqual(store.covered(first, 1, 1)?.lines, ["a"]);

  await observeToolResult(event({ toolName: "edit", input: { path: first } }), dir, store);
  assert.equal(store.covered(first, 1, 1), undefined);
  assert.deepEqual(store.covered(second, 1, 1)?.lines, ["b"]);

  await observeToolResult(event({ toolName: "write", input: { path: second } }), dir, store);
  assert.equal(store.covered(second, 1, 1), undefined);
});

test("find, ls, and bash results do not establish content snapshots", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "needle\n", "utf8");

  for (const toolName of ["find", "ls", "bash"]) {
    const store = new SnapshotStore();
    await observeToolResult(event({
      toolName,
      input: { path: dir, command: "grep -n needle a.txt" },
      content: [{ type: "text", text: "a.txt:1: needle" }]
    }), dir, store);
    assert.equal(store.covered(file, 1, 1), undefined);
  }
});
