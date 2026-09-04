import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { leanEdit, StaleEditError } from "../src/edit-tool.ts";
import { leanRead } from "../src/read-tool.ts";
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

function readText(result: Awaited<ReturnType<typeof leanRead>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

async function expectStaleRefresh(run: () => Promise<unknown>): Promise<StaleEditError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StaleEditError);
  return caught;
}

test("edit without read returns current text and refreshes the snapshot", async () => {
  const session = await createSession("a\nb\n");
  const input = { path: session.file, startLine: 1, newText: "x" };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.message, "edit not applied: one or more requested ranges were not read beforehand.");
  assert.equal(error.refreshedText, "1 │ a\n2 │ b");
  await expectFile(session, "a\nb\n");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "x\nb\n");
});

test("failed line edit returns and snapshots five surrounding lines", async () => {
  const content = Array.from({ length: 15 }, (_, index) => String(index + 1)).join("\n") + "\n";
  const session = await createSession(content);
  const error = await expectStaleRefresh(() => leanEdit(session.dir, { path: session.file, startLine: 6, endLine: 7, newText: "six\nseven" }, session.store));
  const expected = Array.from({ length: 12 }, (_, index) => `${index + 1} │ ${index + 1}`).join("\n");
  assert.equal(error.refreshedText, expected);
  assert.deepEqual(session.store.ranges(session.file), [{ startLine: 1, endLine: 12 }]);

  await leanEdit(session.dir, { path: session.file, startLine: 5, endLine: 6, newText: "five\nSIX" }, session.store);
  await expectFile(session, content.replace("5\n6\n", "five\nSIX\n"));
});

test("failed line edit context clips to file boundaries", async () => {
  const content = Array.from({ length: 15 }, (_, index) => String(index + 1)).join("\n") + "\n";

  const atStart = await createSession(content);
  const startError = await expectStaleRefresh(() => leanEdit(atStart.dir, { path: atStart.file, startLine: 2, newText: "two" }, atStart.store));
  assert.equal(startError.refreshedText, Array.from({ length: 7 }, (_, index) => `${index + 1} │ ${index + 1}`).join("\n"));
  assert.deepEqual(atStart.store.ranges(atStart.file), [{ startLine: 1, endLine: 7 }]);

  const atEnd = await createSession(content);
  const endError = await expectStaleRefresh(() => leanEdit(atEnd.dir, { path: atEnd.file, startLine: 14, newText: "fourteen" }, atEnd.store));
  assert.equal(endError.refreshedText, Array.from({ length: 7 }, (_, index) => `${index + 9} │ ${index + 9}`).join("\n"));
  assert.deepEqual(atEnd.store.ranges(atEnd.file), [{ startLine: 9, endLine: 15 }]);
});

test("overlapping or touching failed-edit context windows merge without duplicate output", async () => {
  const content = Array.from({ length: 25 }, (_, index) => String(index + 1)).join("\n") + "\n";
  const session = await createSession(content);
  const error = await expectStaleRefresh(() => leanEdit(session.dir, {
    path: session.file,
    edits: [
      { startLine: 6, newText: "six" },
      { startLine: 12, newText: "twelve" },
      { startLine: 23, newText: "twenty-three" }
    ]
  }, session.store));
  const lines = Array.from({ length: 25 }, (_, index) => String(index + 1));
  const expected = lines.map((line, index) => `${index + 1} │ ${line}`).join("\n");
  assert.equal(error.refreshedText, expected);
  assert.deepEqual(session.store.ranges(session.file), [{ startLine: 1, endLine: 25 }]);
  assert.deepEqual(session.store.covered(session.file, 1, 25)?.lines, lines);

  await leanEdit(session.dir, { path: session.file, startLine: 17, endLine: 18, newText: "seventeen\neighteen" }, session.store);
  await expectFile(session, content.replace("17\n18\n", "seventeen\neighteen\n"));
});

test("line context subsumes nearby column refresh without duplicate output", async () => {
  const content = Array.from({ length: 15 }, (_, index) => String(index + 1)).join("\n") + "\n";
  const session = await createSession(content);
  const input = {
    path: session.file,
    edits: [
      { startLine: 6, newText: "six" },
      { startLine: 10, startColumn: 1, endColumn: 2, newText: "TEN" }
    ]
  };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, Array.from({ length: 11 }, (_, index) => `${index + 1} │ ${index + 1}`).join("\n"));
  assert.deepEqual(session.store.ranges(session.file), [{ startLine: 1, endLine: 11 }]);
  assert.deepEqual(session.store.columnRanges(session.file), []);

  await leanEdit(session.dir, input, session.store);
  await expectFile(session, content.replace("6\n", "six\n").replace("10\n", "TEN\n"));
});

test("expanded failed-edit context exceeding limits creates no snapshot", async (t) => {
  const content = Array.from({ length: 15 }, (_, index) => String(index + 1)).join("\n") + "\n";

  await t.test("line limit", async () => {
    const session = await createSession(content);
    const input = { path: session.file, startLine: 6, endLine: 7, newText: "six\nseven" };
    await assert.rejects(() => leanEdit(session.dir, input, session.store, { maxLines: 11, maxBytes: 50_000 }), /exceeds automatic refresh limits/);
    assert.deepEqual(session.store.ranges(session.file), []);
    await assert.rejects(() => leanEdit(session.dir, input, session.store, config), StaleEditError);
  });

  await t.test("byte limit", async () => {
    const session = await createSession(content);
    const input = { path: session.file, startLine: 6, endLine: 7, newText: "six\nseven" };
    await assert.rejects(() => leanEdit(session.dir, input, session.store, { maxLines: 2000, maxBytes: 20 }), /exceeds automatic refresh limits/);
    assert.deepEqual(session.store.ranges(session.file), []);
    await assert.rejects(() => leanEdit(session.dir, input, session.store, config), StaleEditError);
  });
});

test("edit range not covered by memorized reads returns and refreshes that range", async () => {
  const session = await createSession("a\nb\nc\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 1 }, config, session.store);
  const input = { path: session.file, startLine: 2, newText: "x" };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1 │ a\n2 │ b\n3 │ c");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "a\nx\nc\n");
});

test("file changed after read returns current text and refreshes snapshot", async () => {
  const session = await createSession("a\nb\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "a\nB\n", "utf8");
  const error = await expectStaleRefresh(() => leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "x" } }, session.store));
  assert.equal(error.message, "edit not applied: the requested text changed since it was read.");
  assert.equal(error.refreshedText, "1 │ a\n2 │ B");
  await expectFile(session, "a\nB\n");
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "x" } }, session.store);
  await expectFile(session, "a\nx\n");
});

test("stale refresh does not snapshot text beyond automatic output limits", async () => {
  const session = await createSession("before\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "updated text\n", "utf8");
  const input = { path: session.file, startLine: 1, newText: "after" };
  await assert.rejects(() => leanEdit(session.dir, input, session.store, { maxLines: 1, maxBytes: 5 }), /exceeds automatic refresh limits/);
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1 │ updated text");
});

test("concurrent stale edits cannot consume each other's refreshed snapshot", async () => {
  const session = await createSession("before\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "external\n", "utf8");
  const results = await Promise.allSettled([
    leanEdit(session.dir, { path: session.file, startLine: 1, newText: "first" }, session.store),
    leanEdit(session.dir, { path: session.file, startLine: 1, newText: "second" }, session.store)
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.ok(results.some((result) => result.status === "rejected" && result.reason instanceof StaleEditError));
  await expectFile(session, "external\n");
});

test("same-process initially valid concurrent edits do not lose updates", async () => {
  const session = await createSession("one\ntwo\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const results = await Promise.allSettled([
    leanEdit(session.dir, { path: session.file, startLine: 1, newText: "ONE" }, session.store),
    leanEdit(session.dir, { path: session.file, startLine: 2, newText: "TWO" }, session.store)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && /snapshot changed while edit was queued/.test(String(result.reason))));
  const content = await fs.readFile(session.file, "utf8");
  assert.ok(content === "ONE\ntwo\n" || content === "one\nTWO\n");
});

test("duplicate text edits only requested range", async () => {
  const session = await createSession("same\nkeep\nsame\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "changed" } }, session.store);
  await expectFile(session, "same\nkeep\nchanged\n");
});

test("CRLF preserved", async () => {
  const session = await createSession("a\r\nb\r\nc\r\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "B" } }, session.store);
  await expectFile(session, "a\r\nB\r\nc\r\n");
});

test("deletion with empty newText", async () => {
  const session = await createSession("a\nb\nc\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "" } }, session.store);
  await expectFile(session, "a\nc\n");
});

test("multi-line replacement", async () => {
  const session = await createSession("a\nb\nc\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, endLine: 3, newText: "B\nC" } }, session.store);
  await expectFile(session, "a\nB\nC\n");
  assert.match(result.diff, /B/);
  assert.equal(result.firstChangedLine, 2);
});

test("successful line-count-changing edit invalidates later snapshots", async () => {
  const session = await createSession("a\nb\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, newText: "A\nAA" } }, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "B" } }, session.store), StaleEditError);
});

test("successful same-line-count edit preserves unaffected rows and refreshes its replacement", async () => {
  const session = await createSession("1\n2\n3\n4\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "TWO" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 4, newText: "FOUR" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "again" } }, session.store);
  await expectFile(session, "1\nagain\n3\nFOUR\n");
});

test("edit can use combined read ranges from same file", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 3 }, config, session.store);
  await leanRead(session.dir, { path: session.file, ...{ offset: 4 }, limit: 3 }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, endLine: 5, newText: "two-five" } }, session.store);
  await expectFile(session, "1\ntwo-five\n6\n");
});

test("overlapping reads use latest overlapping content", async () => {
  const session = await createSession("10\n11\n12\n13\n14\n15\n16\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 5 }, config, session.store);
  await fs.writeFile(session.file, "10\n11\n12\nTHIRTEEN\nFOURTEEN\n15\n16\n", "utf8");
  await leanRead(session.dir, { path: session.file, ...{ offset: 4 }, limit: 3 }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 4, endLine: 6, newText: "merged" } }, session.store);
  await expectFile(session, "10\n11\n12\nmerged\n16\n");
});

test("edit keeps memorized lines before edited range only", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 6 }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, endLine: 4, newText: "three-four" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "TWO" } }, session.store);
  await expectFile(session, "1\nTWO\nthree-four\n5\n6\n");
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{ startLine: 5, newText: "blocked" } }, session.store), StaleEditError);
});

test("multi-range edit applies non-overlapping ranges against original lines", async () => {
  const session = await createSession("a\nb\nc\nd\ne\nf\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "B" },
      { startLine: 5, endLine: 6, newText: "E-F" }
    ]
  } }, session.store);
  await expectFile(session, "a\nB\nc\nd\nE-F\n");
});

test("multi-range edit can use combined read ranges", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 3 }, config, session.store);
  await leanRead(session.dir, { path: session.file, ...{ offset: 5 }, limit: 2 }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 5, newText: "five" }
    ]
  } }, session.store);
  await expectFile(session, "1\ntwo\n3\n4\nfive\n6\n");
});

test("stale multi-range edit refreshes every requested range", async () => {
  const session = await createSession("a\nb\nc\nd\ne\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "a\nB\nc\nd\nE\n", "utf8");
  const input = {
    path: session.file,
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 5, newText: "five" }
    ]
  };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1 │ a\n2 │ B\n3 │ c\n4 │ d\n5 │ E");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "a\ntwo\nc\nd\nfive\n");
});
test("same-line-count multi-range edit preserves unaffected rows and refreshes replacements", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 4, endLine: 5, newText: "four\nfive" }
    ]
  } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 6, newText: "six" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 4, newText: "again" } }, session.store);
  await expectFile(session, "1\ntwo\n3\nagain\nfive\nsix\n");
});

test("mixed multi-range edit invalidates later snapshots if any range changes line count", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 4, newText: "FOUR\nFOUR-B" }
    ]
  } }, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{ startLine: 7, newText: "six" } }, session.store), StaleEditError);
});

test("mixed multi-range edit preserves untouched lines before the line-count change", async () => {
  const session = await createSession("1\n2\n3\n4\n5\n6\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 2, newText: "two" },
      { startLine: 4, newText: "FOUR\nFOUR-B" }
    ]
  } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "three" } }, session.store);
  await expectFile(session, "1\ntwo\nthree\nFOUR\nFOUR-B\n5\n6\n");
});

test("same-line-count column edit preserves unaffected rows and refreshes the complete result", async () => {
  const session = await createSession("abcdef\nsecond\nthird\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "XYZ" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "THIRD" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "QQQ" } }, session.store);
  await expectFile(session, "aQQQef\nsecond\nTHIRD\n");
});

test("empty-string column edit refreshes the complete known result", async () => {
  const session = await createSession("abcdef\nsecond\nthird\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "THIRD" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 2, newText: "Q" } }, session.store);
  await expectFile(session, "aQf\nsecond\nTHIRD\n");
});

test("same-line-count mixed full-line and column edits refresh their complete results", async () => {
  const session = await createSession("abcdef\nsecond\nthird\nfourth\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 4, newText: "" },
      { startLine: 3, newText: "THIRD" }
    ]
  } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 4, newText: "FOURTH" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 2, newText: "Q" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "again" } }, session.store);
  await expectFile(session, "aQf\nsecond\nagain\nFOURTH\n");
});

test("same-line-count mixed batch preserves later snapshots and refreshes replacements", async () => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const session = await createSession(`first\nsecond\n${huge}\n`);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 2 }, config, session.store);
  await leanRead(session.dir, { path: session.file, ...{ offset: 3 }, columnOffset: 6, columnLimit: 3 }, { maxLines: 2000, maxBytes: 12, maxColumns: 3 }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, newText: "FIRST" },
      { startLine: 2, startColumn: 2, endColumn: 3, newText: "" }
    ]
  } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, startColumn: 6, endColumn: 7, newText: "xy" } }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, newText: "again" } }, session.store);
  await expectFile(session, `again\nsond\n01234xy789ABCDEFGHIJ0123456789\n`);
});

test("line-count-changing mixed batch invalidates later column snapshots", async () => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const session = await createSession(`first\nsecond\n${huge}\n`);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 2 }, config, session.store);
  await leanRead(session.dir, { path: session.file, ...{ offset: 3 }, columnOffset: 6, columnLimit: 3 }, { maxLines: 2000, maxBytes: 12, maxColumns: 3 }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, newText: "FIRST\nFIRST-B" },
      { startLine: 2, startColumn: 2, endColumn: 3, newText: "" }
    ]
  } }, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{ startLine: 3, startColumn: 6, endColumn: 7, newText: "xy" } }, session.store), /requested columns are beyond end of line/);
});

test("multi-range edit rejects overlapping ranges", async () => {
  const session = await createSession("a\nb\nc\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, endLine: 2, newText: "x" },
      { startLine: 2, endLine: 3, newText: "y" }
    ]
  } }, session.store), /must not overlap/);
});

test("multi-line read stops at huge line and stores column snapshot", async () => {
  const huge = "x".repeat(80);
  const session = await createSession(`one\ntwo\n${huge}\nfour\n`);
  const result = await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, limit: 4 }, { maxLines: 2000, maxBytes: 35, maxColumns: 6 }, session.store);
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
  await leanRead(session.dir, { path: session.file }, { maxLines: 2000, maxBytes: 12, maxColumns: 5 }, session.store);
  const result = await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 5 }, session.store);
  const text = readText(result);
  assert.match(text, /1:6-10 │ fghij/);
  assert.match(text, /Continue with offset=1 columnOffset=11\./);
});

test("adjacent huge-line column windows compose for spanning edit", async () => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const session = await createSession(`${huge}\n`);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 1, columnLimit: 4 }, { maxLines: 2000, maxBytes: 20, maxColumns: 4 }, session.store);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 4 }, { maxLines: 2000, maxBytes: 20, maxColumns: 4 }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 3, endColumn: 6, newText: "WXYZ" } }, session.store);
  await expectFile(session, `01WXYZ6789ABCDEFGHIJ0123456789\n`);
});

test("huge line column edit succeeds after reading target span", async () => {
  const huge = "0123456789".repeat(10);
  const session = await createSession(`${huge}\n`);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 }, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" } }, session.store);
  await expectFile(session, `01234xyz89${"0123456789".repeat(9)}\n`);
});

test("huge line column edit returns an unread target span before retrying", async () => {
  const huge = "0123456789ABCDEFGHIJ";
  const session = await createSession(`${huge}\n`);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 1, columnLimit: 4 }, { maxLines: 2000, maxBytes: 50, maxColumns: 4 }, session.store);
  const input = { path: session.file, startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1:6-8 │ 567");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "01234xyz89ABCDEFGHIJ\n");
});

test("stale huge-line column edit refreshes the target window", async () => {
  const huge = "0123456789ABCDEFGHIJ";
  const session = await createSession(`${huge}\n`);
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 }, session.store);
  await fs.writeFile(session.file, "01234ZZZ89ABCDEFGHIJ\n", "utf8");
  const input = { path: session.file, ...{ startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" } };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1:6-8 │ ZZZ");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "01234xyz89ABCDEFGHIJ\n");
});

test("stale huge-line refresh respects the configured column limit", async () => {
  const session = await createSession("0123456789ABCDEFGHIJ\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 }, session.store);
  await fs.writeFile(session.file, "01234ZZZ89ABCDEFGHIJ\n", "utf8");
  const input = { path: session.file, ...{ startLine: 1, startColumn: 6, endColumn: 8, newText: "xyz" } };
  await assert.rejects(
    () => leanEdit(session.dir, input, session.store, { maxLines: 2000, maxBytes: 50_000, maxColumns: 2 }),
    /exceeds automatic refresh limits/
  );
});

test("normal line column edit succeeds after whole line read", async () => {
  const session = await createSession("abcdef\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "XYZ" } }, session.store);
  await expectFile(session, "aXYZef\n");
});

test("column edit can insert new lines and refreshes invalidated later snapshots", async () => {
  const session = await createSession("abcdef\nsecond\nthird\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 4, newText: "X\nY" }, session.store);
  await expectFile(session, "aX\nYef\nsecond\nthird\n");
  const error = await expectStaleRefresh(() => leanEdit(session.dir, { path: session.file, startLine: 3, newText: "SECOND" }, session.store));
  assert.equal(error.refreshedText, "1 │ aX\n2 │ Yef\n3 │ second\n4 │ third");
});

test("stale normal-line column edit refreshes the whole line", async () => {
  const session = await createSession("abcdef\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "aBCDef\n", "utf8");
  const input = { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 4, newText: "XYZ" } };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1 │ aBCDef");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "aXYZef\n");
});
test("normal line column edit refreshes insufficient column coverage", async () => {
  const session = await createSession("abcdef\n");
  await leanRead(session.dir, { path: session.file, ...{ offset: 1 }, columnOffset: 2, columnLimit: 3 }, { maxLines: 2000, maxBytes: 50, maxColumns: 3 }, session.store);
  const input = { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: "ZZ" };
  const error = await expectStaleRefresh(() => leanEdit(session.dir, input, session.store));
  assert.equal(error.refreshedText, "1:2-3 │ bc");
  await leanEdit(session.dir, input, session.store);
  await expectFile(session, "aZZdef\n");
});

test("multiple column edits on same line apply bottom-up", async () => {
  const session = await createSession("abcdefghij\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 3, newText: "XX" },
      { startLine: 1, startColumn: 7, endColumn: 8, newText: "YY" }
    ]
  } }, session.store);
  await expectFile(session, "aXXdefYYij\n");
});

test("overlapping column edits reject", async () => {
  const session = await createSession("abcdefghij\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, startColumn: 2, endColumn: 4, newText: "XX" },
      { startLine: 1, startColumn: 4, endColumn: 5, newText: "YY" }
    ]
  } }, session.store), /must not overlap/);
});

test("mixing full-line and column edit on same line rejects", async () => {
  const session = await createSession("abcdefghij\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, ...{
    edits: [
      { startLine: 1, newText: "whole" },
      { startLine: 1, startColumn: 2, endColumn: 3, newText: "XX" }
    ]
  } }, session.store), /cannot mix full-line and column edits on same line/);
});

test("column edit preserves CRLF", async () => {
  const session = await createSession("abcdef\r\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 1, startColumn: 2, endColumn: 3, newText: "ZZ" } }, session.store);
  await expectFile(session, "aZZdef\r\n");
});

test("multiline column edit uses the file's CRLF line ending", async () => {
  const session = await createSession("abcdef\r\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: "X\nY" }, session.store);
  await expectFile(session, "aX\r\nYdef\r\n");
});

test("read does not memorize partial first line as full-line snapshot", async () => {
  const { dir, file } = await tempFile("abcdef\nnext\n");
  const store = new SnapshotStore();
  const result = await leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 8, maxColumns: 3 }, store);
  assert.equal(result.details.leanRead?.linesShown, 1);
  assert.equal(result.details.truncation?.truncatedBy, "columns");
  assert.equal(result.details.truncation?.firstLineExceedsLimit, true);
  assert.deepEqual(store.ranges(file), []);
  assert.deepEqual(store.columnRanges(file), [{ line: 1, startColumn: 1, endColumn: 1 }]);
  const input = { path: file, startLine: 1, newText: "changed" };
  const error = await expectStaleRefresh(() => leanEdit(dir, input, store));
  assert.equal(error.refreshedText, "1 │ abcdef\n2 │ next");
  await leanEdit(dir, input, store);
  assert.equal(await fs.readFile(file, "utf8"), "changed\nnext\n");
});

test("read past EOF does not memorize empty range", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await leanRead(dir, { path: file, offset: 10 }, config, store);
  assert.deepEqual(store.ranges(file), []);
});

test("read and edit reject non-integer line arguments", async () => {
  const { dir, file } = await tempFile("a\nb\n");
  const store = new SnapshotStore();
  await assert.rejects(() => leanRead(dir, { path: file, offset: 1.5 }, config, store), /offset must be an integer >= 1/);
  await leanRead(dir, { path: file }, config, store);
  await assert.rejects(() => leanEdit(dir, { path: file, startLine: 1.5, newText: "x" }, store), /startLine\/endLine must be integers/);
});

test("full-line seeds follow growing and shrinking batch coordinates", async (t) => {
  await t.test("growing edits", async () => {
    const session = await createSession("a\nb\nc\nd\ne\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, newText: "A\nA2" },
        { startLine: 4, newText: "D\nD2" }
      ]
    }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 6, newText: "D-TWO" }, session.store);
    await expectFile(session, "A\nA2\nb\nc\nD\nD-TWO\ne\n");
  });

  await t.test("shrinking edits", async () => {
    const session = await createSession("a\nb\nc\nd\ne\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, endLine: 2, newText: "AB" },
        { startLine: 4, newText: "D" }
      ]
    }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 3, newText: "DEE" }, session.store);
    await expectFile(session, "AB\nc\nDEE\ne\n");
  });
});

test("full-line deletion seeds no phantom row while newline seeds one empty row", async (t) => {
  await t.test("empty deletion", async () => {
    const session = await createSession("a\nb\nc\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    const revision = session.store.revision(session.file);
    await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "" }, session.store);
    assert.ok(session.store.revision(session.file) > revision);
    assert.equal(session.store.covered(session.file, 1, 1), undefined);
    await assert.rejects(() => leanEdit(session.dir, { path: session.file, startLine: 1, newText: "B" }, session.store), StaleEditError);
    await expectFile(session, "b\nc\n");
  });

  await t.test("one newline", async () => {
    const session = await createSession("a\nb\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "\n" }, session.store);
    assert.deepEqual(session.store.covered(session.file, 1, 1)?.lines, [""]);
    await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "filled" }, session.store);
    await expectFile(session, "filled\nb\n");
  });
});

test("complete-line column edits reseed every safely derived result", async (t) => {
  const cases = [
    { name: "longer", replacement: "LONG", nextEnd: 5, expected: "aZdef\n" },
    { name: "shorter", replacement: "Q", nextEnd: 2, expected: "aZdef\n" },
    { name: "empty", replacement: "", nextEnd: 1, expected: "Zdef\n" }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const session = await createSession("abcdef\n");
      await leanRead(session.dir, { path: session.file }, config, session.store);
      await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: item.replacement }, session.store);
      await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: item.replacement ? 2 : 1, endColumn: item.nextEnd, newText: "Z" }, session.store);
      await expectFile(session, item.expected);
    });
  }

  await t.test("multiline and empty interior rows", async () => {
    const session = await createSession("abcdef\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: "X\n\nY" }, session.store);
    assert.deepEqual(session.store.covered(session.file, 2, 2)?.lines, [""]);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, newText: "FIRST" },
        { startLine: 2, newText: "MIDDLE" },
        { startLine: 3, newText: "LAST" }
      ]
    }, session.store);
    await expectFile(session, "FIRST\nMIDDLE\nLAST\n");
  });

  await t.test("multiple edits and Unicode columns", async () => {
    const session = await createSession("a😀bcdefgh\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, startColumn: 2, endColumn: 2, newText: "LONG" },
        { startLine: 1, startColumn: 7, endColumn: 8, newText: "Q" }
      ]
    }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 5, newText: "🙂" }, session.store);
    await expectFile(session, "a🙂bcdeQh\n");
  });
});

test("partial column edits reseed only authored output at shifted coordinates", async (t) => {
  const huge = "0123456789ABCDEFGHIJ0123456789";
  const partialConfig = { maxLines: 2000, maxBytes: 20, maxColumns: 8 };

  for (const item of [
    { name: "equal", replacement: "xyz" },
    { name: "longer", replacement: "LONG" },
    { name: "shorter", replacement: "Q" }
  ]) {
    await t.test(item.name, async () => {
      const session = await createSession(`${huge}\n`);
      await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 5, columnLimit: 8 }, partialConfig, session.store);
      await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 6, endColumn: 8, newText: item.replacement }, session.store);
      await leanEdit(session.dir, {
        path: session.file,
        startLine: 1,
        startColumn: 6,
        endColumn: 5 + Array.from(item.replacement).length,
        newText: "Z"
      }, session.store);
      await assert.rejects(() => leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 5, endColumn: 5, newText: "P" }, session.store), StaleEditError);
    });
  }

  await t.test("empty replacement adds no partial seed", async () => {
    const session = await createSession(`${huge}\n`);
    await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 5, columnLimit: 8 }, partialConfig, session.store);
    const revision = session.store.revision(session.file);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 6, endColumn: 8, newText: "" }, session.store);
    assert.ok(session.store.revision(session.file) > revision);
    assert.deepEqual(session.store.columnRanges(session.file), []);
    await assert.rejects(() => leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 6, endColumn: 6, newText: "Z" }, session.store), StaleEditError);
  });

  await t.test("empty replacement-only interior row is fully known", async () => {
    const session = await createSession(`${huge}\n`);
    await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 5, columnLimit: 8 }, partialConfig, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 6, endColumn: 8, newText: "X\n\nY" }, session.store);
    assert.deepEqual(session.store.covered(session.file, 2, 2)?.lines, [""]);
    await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "middle" }, session.store);
  });
  await t.test("multiple same-line edits with changed lengths", async () => {
    const session = await createSession(`${huge}\n`);
    await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 3, columnLimit: 2 }, partialConfig, session.store);
    await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 8, columnLimit: 2 }, partialConfig, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, startColumn: 3, endColumn: 4, newText: "LONG" },
        { startLine: 1, startColumn: 8, endColumn: 9, newText: "Q" }
      ]
    }, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, startColumn: 3, endColumn: 6, newText: "X" },
        { startLine: 1, startColumn: 10, endColumn: 10, newText: "Y" }
      ]
    }, session.store);
  });

  await t.test("multiline boundaries, interior, and later same-source edit", async () => {
    const session = await createSession(`${huge}\n`);
    await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 3, columnLimit: 2 }, partialConfig, session.store);
    await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 8, columnLimit: 2 }, partialConfig, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, startColumn: 3, endColumn: 4, newText: "A\nMID\nZ" },
        { startLine: 1, startColumn: 8, endColumn: 9, newText: "Q" }
      ]
    }, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, startColumn: 3, endColumn: 3, newText: "B" },
        { startLine: 2, newText: "INNER" },
        { startLine: 3, startColumn: 1, endColumn: 1, newText: "Y" },
        { startLine: 3, startColumn: 5, endColumn: 5, newText: "R" }
      ]
    }, session.store);
    await assert.rejects(() => leanEdit(session.dir, { path: session.file, startLine: 3, startColumn: 2, endColumn: 2, newText: "hidden" }, session.store), StaleEditError);
  });
});

test("earlier insertion and deletion do not prevent later outputs from being reseeded", async (t) => {
  await t.test("insertion before partial column output", async () => {
    const huge = "0123456789ABCDEFGHIJ0123456789";
    const session = await createSession(`top\n${huge}\n`);
    await leanRead(session.dir, { path: session.file, offset: 1, limit: 1 }, config, session.store);
    await leanRead(session.dir, { path: session.file, offset: 2, columnOffset: 5, columnLimit: 6 }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 }, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, newText: "TOP\nMORE" },
        { startLine: 2, startColumn: 6, endColumn: 8, newText: "XYZ" }
      ]
    }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 3, startColumn: 6, endColumn: 8, newText: "Q" }, session.store);
  });

  await t.test("deletion before full-line output", async () => {
    const session = await createSession("first\nsecond\nthird\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, {
      path: session.file,
      edits: [
        { startLine: 1, newText: "" },
        { startLine: 3, newText: "THIRD" }
      ]
    }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "three" }, session.store);
    await expectFile(session, "second\nthree\n");
  });
});

test("column newline normalization and final-newline state match reseeded text", async (t) => {
  await t.test("CRLF and lone CR replacement", async () => {
    const session = await createSession("abcdef\r\nnext\r\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: "X\rY" }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "SECOND" }, session.store);
    await expectFile(session, "aX\r\nSECOND\r\nnext\r\n");
  });

  await t.test("file without final newline", async () => {
    const session = await createSession("abcdef");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: "XYZ" }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 4, newText: "Q" }, session.store);
    await expectFile(session, "aQdef");
  });

  await t.test("terminal newline from a column replacement", async () => {
    const session = await createSession("abc");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 2, endColumn: 3, newText: "X\n" }, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "done" }, session.store);
    await expectFile(session, "done\n");
  });

  await t.test("terminal newline replacing the only full line", async () => {
    const session = await createSession("a");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "\n" }, session.store);
    await expectFile(session, "\n");
    assert.deepEqual(session.store.covered(session.file, 1, 1)?.lines, [""]);
    await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "filled" }, session.store);
    await expectFile(session, "filled\n");
  });
});

test("external mutation of freshly seeded text is stale and refreshes it", async () => {
  const session = await createSession("before\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "seeded" }, session.store);
  await fs.writeFile(session.file, "external\n", "utf8");
  const error = await expectStaleRefresh(() => leanEdit(session.dir, { path: session.file, startLine: 1, newText: "next" }, session.store));
  assert.equal(error.refreshedText, "1 │ external");
});

test("net-zero batches still invalidate old suffix coverage and reseed later outputs", async () => {
  const session = await createSession("1\n2\n3\n4\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, {
    path: session.file,
    edits: [
      { startLine: 1, newText: "one\nextra" },
      { startLine: 3, endLine: 4, newText: "tail" }
    ]
  }, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 4, newText: "TAIL" }, session.store);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, startLine: 3, newText: "TWO" }, session.store), StaleEditError);
  await expectFile(session, "one\nextra\n2\nTAIL\n");
});

test("partial column seeds use Unicode code-point coordinates", async () => {
  const session = await createSession(`${"😀".repeat(30)}\n`);
  const partialConfig = { maxLines: 2000, maxBytes: 50, maxColumns: 4 };
  await leanRead(session.dir, { path: session.file, offset: 1, columnOffset: 5, columnLimit: 4 }, partialConfig, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 6, endColumn: 7, newText: "a🙂b" }, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, startColumn: 6, endColumn: 8, newText: "Z" }, session.store);
  await expectFile(session, `${"😀".repeat(5)}Z${"😀".repeat(23)}\n`);
});
