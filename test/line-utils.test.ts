import test from "node:test";
import assert from "node:assert/strict";
import { codePointLength, decodeUtf8, joinText, replacementLines, replaceColumns, sliceColumns, splitText } from "../src/line-utils.ts";

test("splitText detects CRLF and final newline", () => {
  const parsed = splitText("a\r\nb\r\n");
  assert.deepEqual(parsed.lines, ["a", "b"]);
  assert.equal(parsed.lineEnding, "\r\n");
  assert.equal(parsed.finalNewline, true);
  assert.equal(joinText(parsed.lines, parsed.lineEnding, parsed.finalNewline), "a\r\nb\r\n");
});

test("splitText normalizes mixed and bare-CR endings like Pi's built-in edit", () => {
  const mixed = splitText("a\r\nb\nc");
  assert.deepEqual(mixed.lines, ["a", "b", "c"]);
  assert.equal(joinText(mixed.lines, mixed.lineEnding, mixed.finalNewline, mixed.bom), "a\r\nb\r\nc");

  const bareCr = splitText("a\rb\r");
  assert.deepEqual(bareCr.lines, ["a", "b"]);
  assert.equal(joinText(bareCr.lines, bareCr.lineEnding, bareCr.finalNewline, bareCr.bom), "a\nb\n");
});

test("replacementLines supports deletion and normalizes line endings", () => {
  assert.deepEqual(replacementLines(""), []);
  assert.deepEqual(replacementLines("x\ny\n"), ["x", "y"]);
  assert.deepEqual(replacementLines("x\r\ny\r"), ["x", "y"]);
});

test("column slicing uses code points", () => {
  const text = "A😀BC";
  assert.equal(codePointLength(text), 4);
  assert.equal(sliceColumns(text, 2, 2), "😀");
  assert.equal(replaceColumns(text, 2, 3, "Z"), "AZC");
});

test("UTF-8 decoding is strict and split/join preserves a BOM", () => {
  assert.throws(() => decodeUtf8(Buffer.from([0xff])), /not valid UTF-8/);
  const parsed = splitText("\uFEFFa\nb\n");
  assert.deepEqual(parsed.lines, ["a", "b"]);
  assert.equal(joinText(parsed.lines, parsed.lineEnding, parsed.finalNewline, parsed.bom), "\uFEFFa\nb\n");
});
