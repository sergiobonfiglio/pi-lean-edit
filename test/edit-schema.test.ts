import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { leanEdit, leanEditSchema, prepareLeanEditArguments } from "../src/edit-tool.ts";

const compositionKeywords = new Set(["anyOf", "oneOf", "allOf"]);

function findCompositionKeywords(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findCompositionKeywords(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(compositionKeywords.has(key) ? [`${path}.${key}`] : []),
    ...findCompositionKeywords(nested, `${path}.${key}`)
  ]);
}

test("edit schema is a provider-compatible canonical object", () => {
  assert.deepEqual(findCompositionKeywords(leanEditSchema), []);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [{ startLine: 14, endLine: 20, newText: "replacement" }]
  }), true);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [{ startLine: 14, startColumn: 1, endColumn: 1, newText: "first\nsecond" }]
  }), true);

  assert.equal(Check(leanEditSchema, {
    path: "file.txt",
    edits: [
      { startLine: 1, newText: "line" },
      { startLine: 2, startColumn: 1, endColumn: 2, newText: "columns" }
    ]
  }), true);
});

test("direct single edits are normalized before schema validation", () => {
  const direct = {
    path: "file.txt",
    startLine: 14,
    startColumn: 1,
    endColumn: 2,
    newText: "replacement"
  };
  const prepared = prepareLeanEditArguments(direct);

  assert.deepEqual(prepared, {
    path: "file.txt",
    edits: [{ startLine: 14, startColumn: 1, endColumn: 2, newText: "replacement" }]
  });
  assert.equal(Check(leanEditSchema, prepared), true);
  assert.equal(Check(leanEditSchema, direct), false);

  const batch = { path: "file.txt", edits: [{ startLine: 1, newText: "line" }] };
  assert.equal(prepareLeanEditArguments(batch), batch);
});

test("edit runtime defensively rejects invalid schema combinations", async () => {
  await assert.rejects(() => leanEdit(process.cwd(), {
    path: "file.txt",
    edits: [{
      startLine: 14,
      endLine: 20,
      startColumn: 1,
      endColumn: 1,
      newText: "replacement"
    }]
  } as never), /column edits must stay within one line/);

  await assert.rejects(() => leanEdit(process.cwd(), {
    path: "file.txt",
    startLine: 1,
    newText: "line",
    edits: [{ startLine: 1, newText: "line" }]
  } as never), /cannot combine top-level range fields with edits/);
});
