import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { smartEdit } from "../src/edit-tool.ts";
import { smartRead } from "../src/read-tool.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

async function tempFile(content: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-smart-edit-"));
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, content, "utf8");
  return { dir, file: await fs.realpath(file) };
}

const config = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 };

test("edit without read fails", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 1, newText: "x" }, store), /file stale, read again/);
});

test("edit range not covered by memorized reads fails", async () => {
  const { dir, file } = await tempFile("a\nb\nc\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, limit: 1 }, config, store);
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 2, newText: "x" }, store), /known ranges 1-1/);
});

test("file changed after read fails", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await fs.writeFile(file, "a\nB\n", "utf8");
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 2, newText: "x" }, store), /file stale, read again/);
});

test("duplicate text edits only requested range", async () => {
  const { dir, file } = await tempFile("same\nkeep\nsame\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, { path: file, startLine: 3, newText: "changed" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "same\nkeep\nchanged\n");
});

test("CRLF preserved", async () => {
  const { dir, file } = await tempFile("a\r\nb\r\nc\r\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, { path: file, startLine: 2, newText: "B" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "a\r\nB\r\nc\r\n");
});

test("deletion with empty newText", async () => {
  const { dir, file } = await tempFile("a\nb\nc\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, { path: file, startLine: 2, newText: "" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "a\nc\n");
});

test("multi-line replacement", async () => {
  const { dir, file } = await tempFile("a\nb\nc\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  const result = await smartEdit(dir, { path: file, startLine: 2, endLine: 3, newText: "B\nC" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "a\nB\nC\n");
  assert.match(result.diff, /B/);
  assert.equal(result.firstChangedLine, 2);
});

test("successful edit invalidates snapshot", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, { path: file, startLine: 1, newText: "A" }, store);
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 2, newText: "B" }, store), /file stale, read again/);
});

test("edit can use combined read ranges from same file", async () => {
  const { dir, file } = await tempFile("1\n2\n3\n4\n5\n6\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, limit: 3 }, config, store);
  await smartRead(dir, { path: file, offset: 4, limit: 3 }, config, store);
  await smartEdit(dir, { path: file, startLine: 2, endLine: 5, newText: "two-five" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "1\ntwo-five\n6\n");
});

test("overlapping reads use latest overlapping content", async () => {
  const { dir, file } = await tempFile("10\n11\n12\n13\n14\n15\n16\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, limit: 5 }, config, store);
  await fs.writeFile(file, "10\n11\n12\nTHIRTEEN\nFOURTEEN\n15\n16\n", "utf8");
  await smartRead(dir, { path: file, offset: 4, limit: 3 }, config, store);
  await smartEdit(dir, { path: file, startLine: 4, endLine: 6, newText: "merged" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "10\n11\n12\nmerged\n16\n");
});

test("edit keeps memorized lines before edited range only", async () => {
  const { dir, file } = await tempFile("1\n2\n3\n4\n5\n6\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, limit: 6 }, config, store);
  await smartEdit(dir, { path: file, startLine: 3, endLine: 4, newText: "three-four" }, store);
  await smartEdit(dir, { path: file, startLine: 2, newText: "TWO" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "1\nTWO\nthree-four\n5\n6\n");
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 5, newText: "blocked" }, store), /file stale, read again/);
});

test("multi-range edit applies non-overlapping ranges against original lines", async () => {
  const { dir, file } = await tempFile("a\nb\nc\nd\ne\nf\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, {
    path: file,
    edits: [
      { startLine: 2, newText: "B" },
      { startLine: 5, endLine: 6, newText: "E-F" }
    ]
  }, store);
  assert.equal(await fs.readFile(file, "utf8"), "a\nB\nc\nd\nE-F\n");
});

test("multi-range edit can use combined read ranges", async () => {
  const { dir, file } = await tempFile("1\n2\n3\n4\n5\n6\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, limit: 3 }, config, store);
  await smartRead(dir, { path: file, offset: 5, limit: 2 }, config, store);
  await smartEdit(dir, {
    path: file,
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 5, newText: "five" }
    ]
  }, store);
  assert.equal(await fs.readFile(file, "utf8"), "1\ntwo\n3\n4\nfive\n6\n");
});

test("multi-range edit rejects overlapping ranges", async () => {
  const { dir, file } = await tempFile("a\nb\nc\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await assert.rejects(() => smartEdit(dir, {
    path: file,
    edits: [
      { startLine: 1, endLine: 2, newText: "x" },
      { startLine: 2, endLine: 3, newText: "y" }
    ]
  }, store), /must not overlap/);
});

test("multi-line read stops at huge line and stores column snapshot", async () => {
  const huge = "x".repeat(80);
  const { dir, file } = await tempFile(`one\ntwo\n${huge}\nfour\n`);
  const store = new SnapshotStore();
  const result = await smartRead(dir, { path: file, offset: 1, limit: 4 }, { maxLines: 2000, maxBytes: 35, maxColumns: 6 }, store);
  assert.match(result.text, /1 │ one/);
  assert.match(result.text, /2 │ two/);
  assert.match(result.text, /3:1-6 │ x{6}/);
  assert.doesNotMatch(result.text, /4 │ four/);
  assert.match(result.text, /Continue with offset=3 columnOffset=7\./);
  assert.deepEqual(store.ranges(file), [{ startLine: 1, endLine: 2 }]);
  assert.deepEqual(store.columnRanges(file), [{ line: 3, startColumn: 1, endColumn: 6 }]);
});

test("huge line continuation reads next column window", async () => {
  const huge = "abcdefghijklmnopqrstuvwxyz";
  const { dir, file } = await tempFile(`${huge}\n`);
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 12, maxColumns: 5 }, store);
  const result = await smartRead(dir, { path: file, offset: 1, columnOffset: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 5 }, store);
  assert.match(result.text, /1:6-10 │ fghij/);
  assert.match(result.text, /Continue with offset=1 columnOffset=11\./);
});

test("huge line column edit succeeds after reading target span", async () => {
  const huge = "0123456789".repeat(10);
  const { dir, file } = await tempFile(`${huge}\n`);
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 }, store);
  await smartEdit(dir, { path: file, startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" }, store);
  assert.equal(await fs.readFile(file, "utf8"), `01234xyz89${"0123456789".repeat(9)}\n`);
});

test("huge line column edit fails if target span not read", async () => {
  const huge = "0123456789ABCDEFGHIJ";
  const { dir, file } = await tempFile(`${huge}\n`);
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, columnOffset: 1, columnLimit: 4 }, { maxLines: 2000, maxBytes: 50, maxColumns: 4 }, store);
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" }, store), /known ranges 1:1-4/);
});

test("huge line column edit fails if target substring changed after read", async () => {
  const huge = "0123456789ABCDEFGHIJ";
  const { dir, file } = await tempFile(`${huge}\n`);
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 50, maxColumns: 6 }, store);
  await fs.writeFile(file, "01234ZZZ89ABCDEFGHIJ\n", "utf8");
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" }, store), /file stale, read again/);
});

test("normal line column edit succeeds after whole line read", async () => {
  const { dir, file } = await tempFile("abcdef\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, { path: file, startLine: 1, startColumn: 2, endColumn: 4, newText: "XYZ" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "aXYZef\n");
});

test("normal line column edit fails after column-only read", async () => {
  const huge = "abcdefghijabcdefghijabcdefghij";
  const { dir, file } = await tempFile(`${huge}\nshort\n`);
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 1, columnOffset: 1, columnLimit: 5 }, { maxLines: 2000, maxBytes: 12, maxColumns: 5 }, store);
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 2, startColumn: 1, endColumn: 2, newText: "ZZ" }, store), /known ranges 1:1-2/);
});

test("multiple column edits on same line apply bottom-up", async () => {
  const { dir, file } = await tempFile("abcdefghij\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, {
    path: file,
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 3, newText: "XX" },
      { startLine: 1, startColumn: 7, endColumn: 8, newText: "YY" }
    ]
  }, store);
  assert.equal(await fs.readFile(file, "utf8"), "aXXdefYYij\n");
});

test("overlapping column edits reject", async () => {
  const { dir, file } = await tempFile("abcdefghij\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await assert.rejects(() => smartEdit(dir, {
    path: file,
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 4, newText: "XX" },
      { startLine: 1, startColumn: 4, endColumn: 5, newText: "YY" }
    ]
  }, store), /must not overlap/);
});

test("mixing full-line and column edit on same line rejects", async () => {
  const { dir, file } = await tempFile("abcdefghij\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await assert.rejects(() => smartEdit(dir, {
    path: file,
    edits: [
      { startLine: 1, newText: "whole" },
      { startLine: 1, startColumn: 2, endColumn: 3, newText: "XX" }
    ]
  }, store), /cannot mix full-line and column edits on same line/);
});

test("column edit preserves CRLF", async () => {
  const { dir, file } = await tempFile("abcdef\r\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file }, config, store);
  await smartEdit(dir, { path: file, startLine: 1, startColumn: 2, endColumn: 3, newText: "ZZ" }, store);
  assert.equal(await fs.readFile(file, "utf8"), "aZZdef\r\n");
});

test("read does not memorize partial first line as full-line snapshot", async () => {
  const { dir, file } = await tempFile("abcdef\nnext\n");
  const store = new SnapshotStore();
  const result = await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 8, maxColumns: 3 }, store);
  assert.equal(result.details.smartRead.linesShown, 1);
  assert.equal(result.details.truncation?.truncatedBy, "columns");
  assert.equal(result.details.truncation?.firstLineExceedsLimit, true);
  assert.deepEqual(store.ranges(file), []);
  assert.deepEqual(store.columnRanges(file), [{ line: 1, startColumn: 1, endColumn: 1 }]);
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 1, newText: "changed" }, store), /known ranges 1:1-1/);
});

test("read past EOF does not memorize empty range", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await smartRead(dir, { path: file, offset: 10 }, config, store);
  assert.deepEqual(store.ranges(file), []);
});

test("read and edit reject non-integer line arguments", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await assert.rejects(() => smartRead(dir, { path: file, offset: 1.5 }, config, store), /offset must be an integer >= 1/);
  await smartRead(dir, { path: file }, config, store);
  await assert.rejects(() => smartEdit(dir, { path: file, startLine: 1.5, newText: "x" }, store), /startLine\/endLine must be integers/);
});
