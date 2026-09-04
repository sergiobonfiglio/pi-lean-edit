import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StaleEditError } from "../src/edit-tool.ts";
import { leanEditHugeLine, leanReadHugeLine } from "../src/huge-line-tools.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

const config = { maxLines: 2000, maxBytes: 30, maxColumns: 6 };

async function session(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-huge-"));
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, content, "utf8");
  return { dir, file: await fs.realpath(file), store: new SnapshotStore() };
}

function text(result: Awaited<ReturnType<typeof leanReadHugeLine>>): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

async function stale(run: () => Promise<unknown>): Promise<StaleEditError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof StaleEditError);
    return error;
  }
  assert.fail("expected stale edit");
}

test("read_huge_line rejects normal lines", async () => {
  const s = await session("normal\n");
  await assert.rejects(() => leanReadHugeLine(s.dir, { path: s.file, line: 1 }, config, s.store), /not huge; use read instead/);
  assert.deepEqual(s.store.columnRanges(s.file), []);
});

test("read_huge_line returns bounded Unicode code-point windows", async () => {
  const s = await session(`${"😀".repeat(30)}\n`);
  const result = await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 5, columnLimit: 3 }, config, s.store);
  assert.match(text(result), /^1:5-7 │ 😀😀😀/);
  assert.match(text(result), /Continue with columnOffset=8/);
  assert.deepEqual(s.store.columnRanges(s.file), [{ line: 1, startColumn: 5, endColumn: 7 }]);
});

test("adjacent huge-line windows compose for a spanning edit", async () => {
  const original = "0123456789".repeat(10);
  const s = await session(`${original}\n`);
  await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 3, columnLimit: 4 }, config, s.store);
  await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 7, columnLimit: 4 }, config, s.store);
  await leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 5, endColumn: 8, newText: "WXYZ" }, s.store, config);
  assert.equal(await fs.readFile(s.file, "utf8"), `${original.slice(0, 4)}WXYZ${original.slice(8)}\n`);
});

test("edit_huge_line refreshes an unread range before retry", async () => {
  const s = await session(`${"0123456789".repeat(10)}\n`);
  const input = { path: s.file, line: 1, startColumn: 6, endColumn: 8, newText: "xyz" };
  const error = await stale(() => leanEditHugeLine(s.dir, input, s.store, config));
  assert.equal(error.refreshedText, "1:6-8 │ 567");
  await leanEditHugeLine(s.dir, input, s.store, config);
  assert.match(await fs.readFile(s.file, "utf8"), /^01234xyz89/);
});

test("edit_huge_line detects stale text and reseeds authored replacement", async () => {
  const s = await session(`${"0123456789".repeat(10)}\n`);
  await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 5, columnLimit: 6 }, config, s.store);
  await fs.writeFile(s.file, `01234ZZZ89${"0123456789".repeat(9)}\n`, "utf8");
  const input = { path: s.file, line: 1, startColumn: 6, endColumn: 8, newText: "abc" };
  const error = await stale(() => leanEditHugeLine(s.dir, input, s.store, config));
  assert.equal(error.refreshedText, "1:6-8 │ ZZZ");
  await leanEditHugeLine(s.dir, input, s.store, config);
  await leanEditHugeLine(s.dir, { ...input, newText: "🙂" }, s.store, config);
  assert.match(await fs.readFile(s.file, "utf8"), /^01234🙂89/);
});

test("huge-line edits ignore unrelated mutations when requested columns still match", async () => {
  const original = "0123456789".repeat(10);
  const s = await session(`before\n${original}\n`);
  await leanReadHugeLine(s.dir, { path: s.file, line: 2, columnOffset: 5, columnLimit: 6 }, config, s.store);
  await fs.writeFile(s.file, `changed\n${original}\n`, "utf8");
  await leanEditHugeLine(s.dir, { path: s.file, line: 2, startColumn: 6, endColumn: 8, newText: "XYZ" }, s.store, config);
  assert.equal(await fs.readFile(s.file, "utf8"), `changed\n${original.slice(0, 5)}XYZ${original.slice(8)}\n`);
});
test("edit_huge_line forbids newlines and preserves CRLF", async () => {
  const s = await session(`${"abcdef".repeat(20)}\r\nnext\r\n`);
  await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 2, columnLimit: 4 }, config, s.store);
  await assert.rejects(
    () => leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 2, endColumn: 3, newText: "X\nY" }, s.store, config),
    /must not contain newlines/
  );
  await leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 2, endColumn: 3, newText: "ZZ" }, s.store, config);
  assert.match(await fs.readFile(s.file, "utf8"), /^aZZdef/);
  assert.match(await fs.readFile(s.file, "utf8"), /\r\nnext\r\n$/);
});

test("same-process disjoint huge-line edits are serialized without losing updates", async () => {
  const s = await session(`${"0123456789".repeat(10)}\n`);
  await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 2, columnLimit: 6 }, config, s.store);
  const results = await Promise.allSettled([
    leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 2, endColumn: 3, newText: "AA" }, s.store, config),
    leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 5, endColumn: 6, newText: "BB" }, s.store, config)
  ]);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.match(await fs.readFile(s.file, "utf8"), /^0AA3BB6789/);
});

test("read_huge_line keeps the rendered window within byte and column limits", async () => {
  const s = await session(`${"x".repeat(100)}\n`);
  const limited = { maxLines: 2000, maxBytes: 18, maxColumns: 100 };
  const result = await leanReadHugeLine(s.dir, { path: s.file, line: 1 }, limited, s.store);
  const renderedWindow = text(result).split("\n")[0]!;
  assert.ok(Buffer.byteLength(renderedWindow, "utf8") <= limited.maxBytes);
  const details = result.details.leanRead!;
  assert.ok(details.endColumn! - details.startColumn! + 1 <= limited.maxColumns);
});

test("edit_huge_line stale refresh respects the configured column limit", async () => {
  const s = await session(`${"0123456789".repeat(10)}\n`);
  await assert.rejects(
    () => leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 2, endColumn: 5, newText: "x" }, s.store, { ...config, maxColumns: 3 }),
    /exceeds automatic refresh limits/
  );
  assert.deepEqual(s.store.columnRanges(s.file), []);
});

test("edit_huge_line returns a bounded diff with the real line number", async () => {
  const huge = "x".repeat(1_000_000);
  const s = await session(`prefix\n${huge}\n`);
  const largeConfig = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 };
  await leanReadHugeLine(s.dir, { path: s.file, line: 2, columnOffset: 500_000, columnLimit: 1 }, largeConfig, s.store);
  const result = await leanEditHugeLine(s.dir, { path: s.file, line: 2, startColumn: 500_000, endColumn: 500_000, newText: "Y" }, s.store, largeConfig);
  assert.ok(Buffer.byteLength(result.diff, "utf8") < 2_000);
  assert.match(result.diff, /@@ -2,1 \+2,1 @@/);
  assert.match(result.diff, /Y/);
});

test("edit_huge_line preserves a UTF-8 BOM", async () => {
  const s = await session(`\uFEFF${"x".repeat(100)}\n`);
  await leanReadHugeLine(s.dir, { path: s.file, line: 1, columnOffset: 1, columnLimit: 1 }, config, s.store);
  await leanEditHugeLine(s.dir, { path: s.file, line: 1, startColumn: 1, endColumn: 1, newText: "Y" }, s.store, config);
  assert.equal((await fs.readFile(s.file, "utf8")).startsWith("\uFEFFY"), true);
});
