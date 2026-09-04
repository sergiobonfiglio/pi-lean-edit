import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { leanEdit, leanEditSchema, prepareLeanEditArguments } from "../src/edit-tool.ts";
import { leanEditHugeLineSchema, leanReadHugeLineSchema } from "../src/huge-line-tools.ts";

const compositionKeywords = new Set(["anyOf", "oneOf", "allOf"]);

function findCompositionKeywords(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findCompositionKeywords(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(compositionKeywords.has(key) ? [`${path}.${key}`] : []),
    ...findCompositionKeywords(nested, `${path}.${key}`)
  ]);
}

test("edit schema is a provider-compatible full-line object", () => {
  assert.deepEqual(findCompositionKeywords(leanEditSchema), []);
  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [{ startLine: 14, endLine: 20, newText: "replacement" }]
  }), true);
  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [{ startLine: 14, startColumn: 1, endColumn: 1, newText: "column" }]
  }), false);
});

test("huge-line schemas expose dedicated single-window shapes", () => {
  assert.deepEqual(findCompositionKeywords(leanReadHugeLineSchema), []);
  assert.deepEqual(findCompositionKeywords(leanEditHugeLineSchema), []);
  assert.equal(Check(leanReadHugeLineSchema, { path: "file.txt", line: 2, columnOffset: 4, columnLimit: 8 }), true);
  assert.equal(Check(leanEditHugeLineSchema, { path: "file.txt", line: 2, startColumn: 4, endColumn: 8, newText: "text" }), true);
  assert.equal(Check(leanEditHugeLineSchema, { path: "file.txt", edits: [] }), false);
});

test("direct single line edits are normalized before schema validation", () => {
  const direct = { path: "file.txt", startLine: 14, endLine: 15, newText: "replacement" };
  const prepared = prepareLeanEditArguments(direct);
  assert.deepEqual(prepared, {
    path: "file.txt",
    edits: [{ startLine: 14, endLine: 15, newText: "replacement" }]
  });
  assert.equal(Check(leanEditSchema, prepared), true);
  assert.equal(Check(leanEditSchema, direct), false);

  const batch = { path: "file.txt", edits: [{ startLine: 1, newText: "line" }] };
  assert.equal(prepareLeanEditArguments(batch), batch);
});

test("normal edit rejects column fields", async () => {
  assert.throws(
    () => prepareLeanEditArguments({ path: "file.txt", startLine: 1, startColumn: 1, endColumn: 1, newText: "x" }),
    /column edits require edit_huge_line/
  );
  await assert.rejects(() => leanEdit(process.cwd(), {
    path: "file.txt",
    edits: [{ startLine: 1, startColumn: 1, endColumn: 1, newText: "line" }]
  } as never), /column edits require edit_huge_line/);
  await assert.rejects(() => leanEdit(process.cwd(), {
    path: "file.txt",
    startLine: 1,
    newText: "line",
    edits: [{ startLine: 1, newText: "line" }]
  } as never), /cannot combine top-level range fields with edits/);
});
