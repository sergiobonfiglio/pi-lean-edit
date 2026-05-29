import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { smartEdit } from "../src/edit-tool.ts";
import { smartRead } from "../src/read-tool.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

async function tempFile(content: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-"));
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, content, "utf8");
  return { dir, file: await fs.realpath(file) };
}

const config = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 };

type Session = { dir: string; file: string; store: SnapshotStore };

async function createSession(content: string): Promise<Session> {
  const { dir, file } = await tempFile(content);
  return { dir, file, store: new SnapshotStore() };
}

async function expectFile(session: Session, expected: string) {
  assert.equal(await fs.readFile(session.file, "utf8"), expected);
}

function readText(result: Awaited<ReturnType<typeof smartRead>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

test("edit without read fails", async () => {
  const session = await createSession("a\nb\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, newText: "x" } }, session.store), /file stale, read again/);
});

test("edit range not covered by memorized reads fails", async () => {
  const session = await createSession("a\nb\nc\n");
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 1 }, config, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "x" } }, session.store), /known ranges 1-1/);
});

test("file changed after read fails", async () => {
  const session = await createSession("a\nb\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "a\nB\n", "utf8");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "x" } }, session.store), /file stale, read again/);
});

test("duplicate text edits only requested range", async () => {
  const session = await createSession("same\nkeep\nsame\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "changed" } }, session.store);
  await expectFile(session, "same\nkeep\nchanged\n");
});

test("CRLF preserved", async () => {
  const session = await createSession("a\r\nb\r\nc\r\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "B" } }, session.store);
  await expectFile(session, "a\r\nB\r\nc\r\n");
});

test("deletion with empty newText", async () => {
  const session = await createSession("a\nb\nc\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "" } }, session.store);
  await expectFile(session, "a\nc\n");
});

test("multi-line replacement", async () => {
  const session = await createSession("a\nb\nc\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  const result = await smartEdit(session.dir, { path: session.file, ...{ startLine: 2, endLine: 3, newText: "B\nC" } }, session.store);
  await expectFile(session, "a\nB\nC\n");
  assert.match(result.diff, /B/);
  assert.equal(result.firstChangedLine, 2);
});

test("successful line-count-changing edit invalidates later snapshots", async () => {
  const session = await createSession("a\nb\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, newText: "A\nAA" } }, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "B" } }, session.store), /file stale, read again/);
});

test("successful same-line-count edit preserves unaffected later snapshots", async () => {
  const session = await createSession("1\n2\n3\n4\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "TWO" } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 4, newText: "FOUR" } }, session.store);
  await expectFile(session, "1\nTWO\n3\nFOUR\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "again" } }, session.store), /file stale, read again/);
});

test("edit can use combined read ranges from same file", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 3 }, config, session.store);
  await smartRead(session.dir, { path: session.file, ...{ offset: 4 }, limit: 3 }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 2, endLine: 5, newText: "two-five" } }, session.store);
  await expectFile(session, "1\ntwo-five\n6\n");
});

test("overlapping reads use latest overlapping content", async () => {
  const session = await createSession("10\n11\n12\n13\n14\n15\n16\n");
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 5 }, config, session.store);
  await fs.writeFile(session.file, "10\n11\n12\nTHIRTEEN\nFOURTEEN\n15\n16\n", "utf8");
  await smartRead(session.dir, { path: session.file, ...{ offset: 4 }, limit: 3 }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 4, endLine: 6, newText: "merged" } }, session.store);
  await expectFile(session, "10\n11\n12\nmerged\n16\n");
});

test("edit keeps memorized lines before edited range only", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 6 }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 3, endLine: 4, newText: "three-four" } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "TWO" } }, session.store);
  await expectFile(session, "1\nTWO\nthree-four\n5\n6\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 5, newText: "blocked" } }, session.store), /file stale, read again/);
});

test("multi-range edit applies non-overlapping ranges against original lines", async () => {
  const session = await createSession("a\nb\nc\nd\ne\nf\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "B" },
      { startLine: 5, endLine: 6, newText: "E-F" }
    ]
  } }, session.store);
  await expectFile(session, "a\nB\nc\nd\nE-F\n");
});

test("multi-range edit can use combined read ranges", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 3 }, config, session.store);
  await smartRead(session.dir, { path: session.file, ...{ offset: 5 }, limit: 2 }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 5, newText: "five" }
    ]
  } }, session.store);
  await expectFile(session, "1\ntwo\n3\n4\nfive\n6\n");
});

test("same-line-count multi-range edit preserves unaffected later snapshots", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 4, endLine: 5, newText: "four\nfive" }
    ]
  } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 6, newText: "six" } }, session.store);
  await expectFile(session, "1\ntwo\n3\nfour\nfive\nsix\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 4, newText: "again" } }, session.store), /file stale, read again/);
});

test("mixed multi-range edit invalidates later snapshots if any range changes line count", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 4, newText: "FOUR\nFOUR-B" }
    ]
  } }, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 7, newText: "six" } }, session.store), /file stale, read again/);
});

test("mixed multi-range edit preserves untouched lines before the line-count change", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 4, newText: "FOUR\nFOUR-B" }
    ]
  } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "three" } }, session.store);
  await expectFile(session, "1\ntwo\nthree\nFOUR\nFOUR-B\n5\n6\n");
});

test("same-line-count column edit preserves unaffected later snapshots on other lines", async () => {
  const session = await createSession("abcdef\nsecond\nthird\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "XYZ" } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "THIRD" } }, session.store);
  await expectFile(session, "aXYZef\nsecond\nTHIRD\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "QQQ" } }, session.store), /file stale, read again/);
});

test("empty-string column edit preserves unaffected later snapshots", async () => {
  const session = await createSession("abcdef\nsecond\nthird\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "" } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "THIRD" } }, session.store);
  await expectFile(session, "aef\nsecond\nTHIRD\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 2, newText: "Q" } }, session.store), /file stale, read again/);
});

test("same-line-count mixed full-line and empty-string column edit preserves unaffected later snapshots", async () => {
  const session = await createSession("abcdef\nsecond\nthird\nfourth\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 4, newText: "" },
      { startLine: 3, newText: "THIRD" }
    ]
  } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 4, newText: "FOURTH" } }, session.store);
  await expectFile(session, "aef\nsecond\nTHIRD\nFOURTH\n");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 2, newText: "Q" } }, session.store), /file stale, read again/);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "again" } }, session.store), /file stale, read again/);
});

test("same-line-count mixed batch preserves later column snapshots", async () => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const session = await createSession(`first\nsecond\n${huge}\n`);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 2 }, config, session.store);
  await smartRead(session.dir, { path: session.file, ...{ offset: 3 }, columnOffset: 6, columnLimit: 3 }, { maxLines: 2000, maxBytes: 12, maxColumns: 3 }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, newText: "FIRST" },
      { startLine: 2, startColumn: 2, endColumn: 3, newText: "" }
    ]
  } }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 3, startColumn: 6, endColumn: 7, newText: "xy" } }, session.store);
  await expectFile(session, `FIRST\nsond\n01234xy789ABCDEFGHIJ0123456789\n`);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, newText: "again" } }, session.store), /file stale, read again/);
});

test("line-count-changing mixed batch invalidates later column snapshots", async () => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const session = await createSession(`first\nsecond\n${huge}\n`);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 2 }, config, session.store);
  await smartRead(session.dir, { path: session.file, ...{ offset: 3 }, columnOffset: 6, columnLimit: 3 }, { maxLines: 2000, maxBytes: 12, maxColumns: 3 }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, newText: "FIRST\nFIRST-B" },
      { startLine: 2, startColumn: 2, endColumn: 3, newText: "" }
    ]
  } }, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 3, startColumn: 6, endColumn: 7, newText: "xy" } }, session.store), /file stale, read again/);
});

test("multi-range edit rejects overlapping ranges", async () => {
  const session = await createSession("a\nb\nc\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, endLine: 2, newText: "x" },
      { startLine: 2, endLine: 3, newText: "y" }
    ]
  } }, session.store), /must not overlap/);
});

test("multi-line read stops at huge line and stores column snapshot", async () => {
  const huge = "x".repeat(80);
  const session = await createSession(`one\ntwo\n${huge}\nfour\n`);
  const result = await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 4 }, { maxLines: 2000, maxBytes: 35, maxColumns: 6 }, session.store);
  const text = readText(result);
  assert.match(text, /1 │ one/);
  assert.match(text, /2 │ two/);
  assert.match(text, /3:1-6 │ x{6}/);
  assert.doesNotMatch(text, /4 │ four/);
  assert.match(text, /Continue with offset=3 columnOffset=7\./);
  assert.deepEqual(session.store.ranges(session.file), [{ startLine: 1, endLine: 2 }]);
  assert.deepEqual(session.store.columnRanges(session.file), [{ line: 3, startColumn: 1, endColumn: 6 }]);
});

test("huge line continuation reads next column window", async () => {
  const huge = "abcdefghijklmnopqrstuvwxyz";
  const session = await createSession(`${huge}\n`);
  await smartRead(session.dir, { path: session.file }, { maxLines: 2000, maxBytes: 12, maxColumns: 5 }, session.store);
  const result = await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 5 }, session.store);
  const text = readText(result);
  assert.match(text, /1:6-10 │ fghij/);
  assert.match(text, /Continue with offset=1 columnOffset=11\./);
});

test("adjacent huge-line column windows compose for spanning edit", async () => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const session = await createSession(`${huge}\n`);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 1, columnLimit: 4 }, { maxLines: 2000, maxBytes: 20, maxColumns: 4 }, session.store);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 4 }, { maxLines: 2000, maxBytes: 20, maxColumns: 4 }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 3, endColumn: 6, newText: "WXYZ" } }, session.store);
  await expectFile(session, `01WXYZ6789ABCDEFGHIJ0123456789\n`);
});

test("huge line column edit succeeds after reading target span", async () => {
  const huge = "0123456789".repeat(10);
  const session = await createSession(`${huge}\n`);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 }, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" } }, session.store);
  await expectFile(session, `01234xyz89${"0123456789".repeat(9)}\n`);
});

test("huge line column edit fails if target span not read", async () => {
  const huge = "0123456789ABCDEFGHIJ";
  const session = await createSession(`${huge}\n`);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 1, columnLimit: 4 }, { maxLines: 2000, maxBytes: 50, maxColumns: 4 }, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" } }, session.store), /known ranges 1:1-4/);
});

test("huge line column edit fails if target substring changed after read", async () => {
  const huge = "0123456789ABCDEFGHIJ";
  const session = await createSession(`${huge}\n`);
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 50, maxColumns: 6 }, session.store);
  await fs.writeFile(session.file, "01234ZZZ89ABCDEFGHIJ\n", "utf8");
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" } }, session.store), /file stale, read again/);
});

test("normal line column edit succeeds after whole line read", async () => {
  const session = await createSession("abcdef\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "XYZ" } }, session.store);
  await expectFile(session, "aXYZef\n");
});

test("normal line column edit fails after same-line column-only read", async () => {
  const session = await createSession("abcdef\n");
  await smartRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 2, columnLimit: 3 }, { maxLines: 2000, maxBytes: 50, maxColumns: 3 }, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 3, newText: "ZZ" } }, session.store), /known ranges 1:2-4/);
});

test("multiple column edits on same line apply bottom-up", async () => {
  const session = await createSession("abcdefghij\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 3, newText: "XX" },
      { startLine: 1, startColumn: 7, endColumn: 8, newText: "YY" }
    ]
  } }, session.store);
  await expectFile(session, "aXXdefYYij\n");
});

test("overlapping column edits reject", async () => {
  const session = await createSession("abcdefghij\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 4, newText: "XX" },
      { startLine: 1, startColumn: 4, endColumn: 5, newText: "YY" }
    ]
  } }, session.store), /must not overlap/);
});

test("mixing full-line and column edit on same line rejects", async () => {
  const session = await createSession("abcdefghij\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await assert.rejects(() => smartEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, newText: "whole" },
      { startLine: 1, startColumn: 2, endColumn: 3, newText: "XX" }
    ]
  } }, session.store), /cannot mix full-line and column edits on same line/);
});

test("column edit preserves CRLF", async () => {
  const session = await createSession("abcdef\r\n");
  await smartRead(session.dir, { path: session.file }, config, session.store);
  await smartEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 3, newText: "ZZ" } }, session.store);
  await expectFile(session, "aZZdef\r\n");
});

test("read does not memorize partial first line as full-line snapshot", async () => {
  const { dir, file } = await tempFile("abcdef\nnext\n");
  const store = new SnapshotStore();
  const result = await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 8, maxColumns: 3 }, store);
  assert.equal(result.details.smartRead?.linesShown, 1);
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
