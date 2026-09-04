import test from "node:test";
import assert from "node:assert/strict";
import { diffStat, unifiedDiff } from "../src/diff.ts";

test("diffStat counts changed content that resembles file headers", () => {
  const diff = unifiedDiff("file.txt", "--old\n", "++new\n");
  assert.deepEqual(diffStat(diff), { added: 1, removed: 1 });
});
