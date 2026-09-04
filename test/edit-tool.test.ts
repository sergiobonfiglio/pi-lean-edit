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

test("unrelated file mutations do not block an edit whose target still matches", async () => {
  const session = await createSession("a\nb\nc\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await fs.writeFile(session.file, "A\nb\nC\n", "utf8");
  await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "B" }, session.store);
  await expectFile(session, "A\nB\nC\n");
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

test("same-process valid concurrent edits are serialized without losing updates", async () => {
  const session = await createSession("one\ntwo\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const results = await Promise.allSettled([
    leanEdit(session.dir, { path: session.file, startLine: 1, newText: "ONE" }, session.store),
    leanEdit(session.dir, { path: session.file, startLine: 2, newText: "TWO" }, session.store)
  ]);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  await expectFile(session, "ONE\nTWO\n");
});

test("duplicate text edits only requested range", async () => {
  const session = await createSession("same\nkeep\nsame\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 3, newText: "changed" } }, session.store);
  await expectFile(session, "same\nkeep\nchanged\n");
});

test("default helper stores preserve direct read-then-edit compatibility", async () => {
  const session = await createSession("before\n");
  await leanRead(session.dir, { path: session.file }, config);
  await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "after" });
  await expectFile(session, "after\n");
});
test("CRLF preserved", async () => {
  const session = await createSession("a\r\nb\r\nc\r\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, ...{ startLine: 2, newText: "B" } }, session.store);
  await expectFile(session, "a\r\nB\r\nc\r\n");
});

test("bare carriage returns in replacement text become line endings", async () => {
  const session = await createSession("a");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "A\r" }, session.store);
  await expectFile(session, "A\n");
});

test("mixed and bare-CR line endings normalize like Pi's built-in edit", async (t) => {
  await t.test("mixed endings follow the first newline style", async () => {
    const session = await createSession("a\r\nb\nc");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 3, newText: "C" }, session.store);
    await expectFile(session, "a\r\nb\r\nC");
  });

  await t.test("bare carriage returns become LF", async () => {
    const session = await createSession("a\rb\r");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "B" }, session.store);
    await expectFile(session, "a\nB\n");
  });
});

test("editing the first line preserves a UTF-8 BOM", async () => {
  const session = await createSession("\uFEFFa\nb\n");
  const read = await leanRead(session.dir, { path: session.file }, config, session.store);
  assert.doesNotMatch(readText(read), /\uFEFF/);
  await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "A" }, session.store);
  await expectFile(session, "\uFEFFA\nb\n");
});

test("invalid UTF-8 is rejected before it can be rewritten", async () => {
  const session = await createSession("placeholder");
  await fs.writeFile(session.file, Buffer.from([0x61, 0x0a, 0xff, 0x0a]));
  await assert.rejects(() => leanRead(session.dir, { path: session.file }, config, session.store), /not valid UTF-8/);
  await assert.rejects(() => leanEdit(session.dir, { path: session.file, startLine: 1, newText: "A" }, session.store), /not valid UTF-8/);
  assert.equal((await fs.readFile(session.file)).toString("hex"), "610aff0a");
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

test("external mutation of freshly seeded text is stale and refreshes it", async () => {
  const session = await createSession("before\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "seeded" }, session.store);
  await fs.writeFile(session.file, "external\n", "utf8");
  const error = await expectStaleRefresh(() => leanEdit(session.dir, { path: session.file, startLine: 1, newText: "next" }, session.store));
  assert.equal(error.refreshedText, "1 │ external");
});

test("identical text at requested coordinates remains editable after another session changes the file", async () => {
  const session = await createSession("x\na\n");
  const otherStore = new SnapshotStore();
  await leanRead(session.dir, { path: session.file }, config, session.store);
  await leanRead(session.dir, { path: session.file }, config, otherStore);
  await leanEdit(session.dir, { path: session.file, startLine: 1, endLine: 2, newText: "y\na\na" }, session.store);

  await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "B" }, otherStore);
  await expectFile(session, "y\nB\na\n");
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

test("deduplicates an exact trailing replacement line at an unchanged boundary", async () => {
  const session = await createSession("function run() {\n  old();\n}\nafter\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, {
    path: session.file,
    startLine: 2,
    newText: "  replacement();\n}"
  }, session.store);

  await expectFile(session, "function run() {\n  replacement();\n}\nafter\n");
  assert.equal(
    result.warning,
    "Deduplicated a trailing replacement line because it exactly matched unchanged source line 3. To keep both lines intentionally, include line 3 in the replacement range and provide both copies explicitly."
  );
});

test("deduplicates exact non-delimiter boundary repetitions", async () => {
  const session = await createSession("old\nreturn done;\nafter\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "updated\nreturn done;" }, session.store);

  await expectFile(session, "updated\nreturn done;\nafter\n");
  assert.match(result.warning ?? "", /unchanged source line 2/);
});

test("an exact one-line replacement matching the following line becomes a deletion", async () => {
  const session = await createSession("remove me\nkeep me\nafter\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "keep me" }, session.store);

  await expectFile(session, "keep me\nafter\n");
  assert.match(result.warning ?? "", /unchanged source line 2/);
});

test("does not deduplicate trim-only boundary equality", async () => {
  const session = await createSession("old\n  repeated\nafter\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, { path: session.file, startLine: 1, newText: "updated\nrepeated" }, session.store);

  await expectFile(session, "updated\nrepeated\n  repeated\nafter\n");
  assert.equal(result.warning, undefined);
});

test("empty deletions and edits at EOF do not trigger boundary deduplication", async (t) => {
  await t.test("empty deletion", async () => {
    const session = await createSession("a\nb\nc\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    const result = await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "" }, session.store);
    await expectFile(session, "a\nc\n");
    assert.equal(result.warning, undefined);
  });

  await t.test("following line absent", async () => {
    const session = await createSession("a\nold\n");
    await leanRead(session.dir, { path: session.file }, config, session.store);
    const result = await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "updated\nextra" }, session.store);
    await expectFile(session, "a\nupdated\nextra\n");
    assert.equal(result.warning, undefined);
  });
});

test("deduplicates independent batch boundaries and reports sorted source lines", async () => {
  const session = await createSession("old one\nshared one\nmiddle\nold two\nshared two\nend\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, {
    path: session.file,
    edits: [
      { startLine: 4, newText: "new two\nshared two" },
      { startLine: 1, newText: "new one\nshared one" }
    ]
  }, session.store);

  await expectFile(session, "new one\nshared one\nmiddle\nnew two\nshared two\nend\n");
  assert.equal(
    result.warning,
    "Deduplicated trailing replacement lines matching unchanged source lines 2 and 5. To keep repeated lines intentionally, include each listed following line in its replacement range and provide both copies explicitly."
  );
});

test("does not deduplicate a following source line changed by an adjacent batch range", async () => {
  const session = await createSession("old\nboundary\ntail\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, {
    path: session.file,
    edits: [
      { startLine: 1, newText: "replacement\nboundary" },
      { startLine: 2, newText: "BOUNDARY" }
    ]
  }, session.store);

  await expectFile(session, "replacement\nboundary\nBOUNDARY\ntail\n");
  assert.equal(result.warning, undefined);
});

test("expanded range preserves intentional adjacent duplicates", async () => {
  const session = await createSession("old\nrepeated\nafter\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, {
    path: session.file,
    startLine: 1,
    endLine: 2,
    newText: "updated\nrepeated\nrepeated"
  }, session.store);

  await expectFile(session, "updated\nrepeated\nrepeated\nafter\n");
  assert.equal(result.warning, undefined);
});

test("boundary deduplication preserves terminal-newline replacement behavior", async () => {
  const session = await createSession("before\nold\nfollowing\nafter");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, {
    path: session.file,
    startLine: 2,
    newText: "replacement\nfollowing\n"
  }, session.store);

  await expectFile(session, "before\nreplacement\nfollowing\nafter");
  assert.match(result.warning ?? "", /unchanged source line 3/);
});

test("boundary deduplication metrics and snapshots use the effective replacement", async () => {
  const session = await createSession("before\nold\nfollowing\nafter\n");
  await leanRead(session.dir, { path: session.file }, config, session.store);
  const result = await leanEdit(session.dir, {
    path: session.file,
    startLine: 2,
    newText: "new\nfollowing"
  }, session.store);

  assert.deepEqual(result.delta, { attempts: 1, failures: 0, charsSaved: 1, charsNormalEdit: 6, charsLeanEdit: 5 });
  await leanEdit(session.dir, { path: session.file, startLine: 2, newText: "again" }, session.store);
  await leanEdit(session.dir, { path: session.file, startLine: 4, newText: "AFTER" }, session.store);
  await expectFile(session, "before\nagain\nfollowing\nAFTER\n");
});
