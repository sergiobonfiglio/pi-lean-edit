import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { leanEdit, StaleEditError } from "../src/edit-tool.ts";
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

function truncation(content: string, lastLinePartial = false) {
  return {
    content,
    truncated: true,
    truncatedBy: "bytes" as const,
    totalLines: content.split("\n").length + 10,
    totalBytes: 100_000,
    outputLines: content.split("\n").length,
    outputBytes: Buffer.byteLength(content),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines: 2000,
    maxBytes: 50_000
  };
}

test("output marker parsing recognizes matches and context without consuming text", () => {
  assert.deepEqual(toolResultObserverInternals.markerCandidates("src/a.ts:12:  indented"), [
    { displayPath: "src/a.ts", line: 12, text: "  indented" }
  ]);
  assert.deepEqual(toolResultObserverInternals.markerCandidates("src/a-file.ts-11-context"), [
    { displayPath: "src/a-file.ts", line: 11, text: "context" }
  ]);
});

test("bash snapshots relative, absolute, match, context, and mixed output rows", async () => {
  const dir = await tempDir();
  const firstPath = path.join(dir, "a-file.txt");
  const secondPath = path.join(dir, "odd:7-file.txt");
  await fs.writeFile(firstPath, "unused\n");
  await fs.writeFile(secondPath, "unused\n");
  const first = await fs.realpath(firstPath);
  const second = await fs.realpath(secondPath);
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "bash",
    input: { command: "anything" },
    content: [{ type: "text", text: [
      "compiler heading",
      "a-file.txt:2:  leading whitespace",
      "a-file.txt-3-context",
      `${second}:4:absolute`,
      "odd:7-file.txt:5:punctuation"
    ].join("\n") }]
  }), dir, store);

  assert.deepEqual(store.covered(first, 2, 3)?.lines, ["  leading whitespace", "context"]);
  assert.deepEqual(store.covered(second, 4, 5)?.lines, ["absolute", "punctuation"]);
});

test("bash ignores ambiguous, malformed, missing, and non-file interpretations", async () => {
  const dir = await tempDir();
  const shortPath = path.join(dir, "prefix");
  const longPath = path.join(dir, "prefix:1:suffix");
  await fs.writeFile(shortPath, "short\n");
  await fs.writeFile(longPath, "long\n");
  await fs.mkdir(path.join(dir, "directory"));
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "bash",
    content: [{ type: "text", text: [
      "prefix:1:suffix:2:ambiguous",
      "missing.txt:1:missing",
      "directory:1:not a file",
      "not a row"
    ].join("\n") }]
  }), dir, store);

  assert.equal(store.covered(await fs.realpath(shortPath), 1, 1), undefined);
  assert.equal(store.covered(await fs.realpath(longPath), 2, 2), undefined);
});

test("incorrect bash text is stored but fails normal edit-time validation", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "actual\n", "utf8");
  const store = new SnapshotStore();
  await observeToolResult(event({
    toolName: "bash",
    content: [{ type: "text", text: "a.txt:1:reported" }]
  }), dir, store);

  assert.deepEqual(store.covered(await fs.realpath(file), 1, 1)?.lines, ["reported"]);
  await assert.rejects(
    () => leanEdit(dir, { path: file, startLine: 1, newText: "changed" }, store),
    StaleEditError
  );
  assert.equal(await fs.readFile(file, "utf8"), "actual\n");
});

test("truncated bash output snapshots complete retained rows and excludes its footer", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "one\ntwo\n", "utf8");
  const retained = "a.txt:1:one\na.txt:2:two";
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "bash",
    content: [{ type: "text", text: `${retained}\n\n[Showing lines 9-10 of 10. Full output: /tmp/output]` }],
    details: { truncation: truncation(retained), fullOutputPath: "/tmp/output" }
  }), dir, store);

  assert.deepEqual(store.covered(await fs.realpath(file), 1, 2)?.lines, ["one", "two"]);
});

test("a partial bash truncation boundary row is discarded while later complete rows remain", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "one\ntwo\n", "utf8");
  const retained = "a.txt:1:partial\na.txt:2:two";
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "bash",
    content: [{ type: "text", text: retained }],
    details: { truncation: truncation(retained, true) }
  }), dir, store);

  const canonical = await fs.realpath(file);
  assert.equal(store.covered(canonical, 1, 1), undefined);
  assert.deepEqual(store.covered(canonical, 2, 2)?.lines, ["two"]);
});

test("failed bash results are ignored", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "actual\n");
  const store = new SnapshotStore();
  await observeToolResult(event({
    toolName: "bash",
    content: [{ type: "text", text: "a.txt:1:actual" }],
    isError: true
  }), dir, store);
  assert.equal(store.covered(await fs.realpath(file), 1, 1), undefined);
});

test("grep and bash snapshot displayed text without reading file contents", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a-file.txt");
  await fs.writeFile(file, "  alpha\nneedle\nomega\n", "utf8");
  const canonical = await fs.realpath(file);
  const store = new SnapshotStore();
  const originalReadFile = fs.readFile;
  let reads = 0;
  (fs as any).readFile = async (...args: any[]) => {
    reads++;
    return originalReadFile.apply(fs, args as any);
  };
  try {
    await observeToolResult(event({
      toolName: "grep",
      input: { pattern: "needle", path: dir, context: 1 },
      content: [{ type: "text", text: [
        "a-file.txt-1-   alpha",
        "a-file.txt:2: needle",
        "a-file.txt-3- omega"
      ].join("\n") }]
    }), dir, store);
    await observeToolResult(event({
      toolName: "bash",
      content: [{ type: "text", text: "a-file.txt:2:needle" }]
    }), dir, store);
  } finally {
    (fs as any).readFile = originalReadFile;
  }

  assert.equal(reads, 0);
  assert.deepEqual(store.covered(canonical, 1, 3)?.lines, ["  alpha", "needle", "omega"]);
});

test("grep stores valid mixed rows, skips individually truncated rows, and enforces containment", async () => {
  const dir = await tempDir();
  const outsideDir = await tempDir();
  const file = path.join(dir, "a.txt");
  const outside = path.join(outsideDir, "outside.txt");
  await fs.writeFile(file, "one\ntwo\n");
  await fs.writeFile(outside, "outside\n");
  const store = new SnapshotStore();

  await observeToolResult(event({
    toolName: "grep",
    input: { path: dir },
    content: [{ type: "text", text: [
      "not a grep row",
      "a.txt:1: displayed",
      "a.txt:2: cut... [truncated]",
      `../${path.basename(outsideDir)}/outside.txt:1: outside`,
      "",
      "[Some lines truncated to 500 chars. Use read tool to see full lines]"
    ].join("\n") }],
    details: { linesTruncated: true }
  }), dir, store);

  const canonical = await fs.realpath(file);
  assert.deepEqual(store.covered(canonical, 1, 1)?.lines, ["displayed"]);
  assert.equal(store.covered(canonical, 2, 2), undefined);
  assert.equal(store.covered(await fs.realpath(outside), 1, 1), undefined);
});

test("a delayed observation cannot restore snapshots cleared by a newer event", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "needle\n", "utf8");
  const canonical = await fs.realpath(file);
  const store = new SnapshotStore();

  const pending = observeToolResult(event({
    toolName: "bash",
    content: [{ type: "text", text: "a.txt:1:needle" }]
  }), dir, store);
  store.clear(canonical);
  await pending;

  assert.equal(store.covered(canonical, 1, 1), undefined);
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

test("find and ls still do not establish content snapshots", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "needle\n", "utf8");

  for (const toolName of ["find", "ls"]) {
    const store = new SnapshotStore();
    await observeToolResult(event({
      toolName,
      input: { path: dir },
      content: [{ type: "text", text: "a.txt:1:needle" }]
    }), dir, store);
    assert.equal(store.covered(await fs.realpath(file), 1, 1), undefined);
  }
});
