import test from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../src/diff.ts";
import { renderDiffForLeanEdit } from "../src/diff-render.ts";

const theme = {
  inverse: (text: string) => `<inverse>${text}</inverse>`,
  fg: (_color: string, text: string) => text
};

test("diff rendering does not advance line numbers for no-newline markers", () => {
  const rendered = renderDiffForLeanEdit(unifiedDiff("file.txt", "old", "new"), theme);
  assert.match(rendered, /-1 old/);
  assert.match(rendered, /\+1 new/);
  assert.doesNotMatch(rendered, /\+2 new/);
});

test("diff rendering highlights whole Unicode code points", () => {
  const rendered = renderDiffForLeanEdit(unifiedDiff("file.txt", "😀\n", "😃\n"), theme);
  assert.match(rendered, /<inverse>😀<\/inverse>/);
  assert.match(rendered, /<inverse>😃<\/inverse>/);
  assert.doesNotMatch(Buffer.from(rendered).toString("utf8"), /�/);
});
