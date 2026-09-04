import test from "node:test";
import assert from "node:assert/strict";
import { codePointLength, hasMixedLineEndings, joinText, replacementLines, replaceColumns, sliceColumns, splitText } from "../src/line-utils.ts";

test("splitText detects CRLF and final newline", () => {
  const parsed = splitText("a\r\nb\r\n");
  assert.deepEqual(parsed.lines, ["a", "b"]);
  assert.equal(parsed.lineEnding, "\r\n");
  assert.equal(parsed.finalNewline, true);
  assert.equal(joinText(parsed.lines, parsed.lineEnding, parsed.finalNewline), "a\r\nb\r\n");
});

test("mixed line endings are detected", () => {
  assert.equal(hasMixedLineEndings("a\nb\n"), false);
  assert.equal(hasMixedLineEndings("a\r\nb\r\n"), false);
  assert.equal(hasMixedLineEndings("a\r\nb\n"), true);
});

test("replacementLines supports deletion and trailing newline", () => {
  assert.deepEqual(replacementLines(""), []);
  assert.deepEqual(replacementLines("x\ny\n"), ["x", "y"]);
});

test("column slicing uses code points", () => {
  const text = "A😀BC";
  assert.equal(codePointLength(text), 4);
  assert.equal(sliceColumns(text, 2, 2), "😀");
  assert.equal(replaceColumns(text, 2, 3, "Z"), "AZC");
});
