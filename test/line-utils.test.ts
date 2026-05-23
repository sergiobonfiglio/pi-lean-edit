import test from "node:test";
import assert from "node:assert/strict";
import { joinText, replacementLines, splitText } from "../src/line-utils.ts";

test("splitText detects CRLF and final newline", () => {
  const parsed = splitText("a\r\nb\r\n");
  assert.deepEqual(parsed.lines, ["a", "b"]);
  assert.equal(parsed.lineEnding, "\r\n");
  assert.equal(parsed.finalNewline, true);
  assert.equal(joinText(parsed.lines, parsed.lineEnding, parsed.finalNewline), "a\r\nb\r\n");
});

test("replacementLines supports deletion and trailing newline", () => {
  assert.deepEqual(replacementLines(""), []);
  assert.deepEqual(replacementLines("x\ny\n"), ["x", "y"]);
});
