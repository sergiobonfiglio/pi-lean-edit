import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { leanEdit, leanEditSchema } from "../src/edit-tool.ts";

test("edit schema separates line and column ranges", () => {
  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    startLine: 14,
    endLine: 20,
    newText: "replacement"
  }), true);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    startLine: 14,
    startColumn: 1,
    endColumn: 1,
    newText: "first\nsecond"
  }), true);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    startLine: 14,
    endLine: 20,
    startColumn: 1,
    endColumn: 1,
    newText: "replacement"
  }), false);
});

test("edit schema separates direct and batched forms", () => {
  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [
      { startLine: 1, newText: "line" },
      { startLine: 2, startColumn: 1, endColumn: 2, newText: "columns" }
    ]
  }), true);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    startLine: 1,
    newText: "line",
    edits: [{ startLine: 1, newText: "line" }]
  }), false);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [{
      startLine: 14,
      endLine: 20,
      startColumn: 1,
      endColumn: 1,
      newText: "replacement"
    }]
  }), false);
});

test("edit runtime defensively rejects invalid schema combinations", async () => {
  await assert.rejects(() => leanEdit(process.cwd(), {
    path: "file.txt",
    startLine: 14,
    endLine: 20,
    startColumn: 1,
    endColumn: 1,
    newText: "replacement"
  } as never), /column edits must stay within one line/);

  await assert.rejects(() => leanEdit(process.cwd(), {
    path: "file.txt",
    startLine: 1,
    newText: "line",
    edits: [{ startLine: 1, newText: "line" }]
  } as never), /cannot combine top-level range fields with edits/);
});
