import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore } from "../src/snapshot-store.ts";

test("non-overlapping reads accumulate", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", startLine: 1, endLine: 2, lines: ["a", "b"] });
  store.set({ path: "/tmp/a", startLine: 5, endLine: 5, lines: ["e"] });
  assert.deepEqual(store.covered("/tmp/a", 1, 2)?.lines, ["a", "b"]);
  assert.deepEqual(store.covered("/tmp/a", 5, 5)?.lines, ["e"]);
  assert.equal(store.covered("/tmp/a", 2, 5), undefined);
});

test("covered requires entire range", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", startLine: 10, endLine: 12, lines: ["j", "k", "l"] });
  assert.equal(store.covered("/tmp/a", 9, 10), undefined);
  assert.equal(store.covered("/tmp/a", 12, 13), undefined);
  assert.ok(store.covered("/tmp/a", 10, 12));
});

test("overlapping reads keep older prefix and newer overlap/suffix", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", startLine: 10, endLine: 20, lines: Array.from({ length: 11 }, (_, i) => `old-${10 + i}`) });
  store.set({ path: "/tmp/a", startLine: 15, endLine: 25, lines: Array.from({ length: 11 }, (_, i) => `new-${15 + i}`) });

  const covered = store.covered("/tmp/a", 10, 25);
  assert.ok(covered);
  assert.deepEqual(covered.lines.slice(0, 5), ["old-10", "old-11", "old-12", "old-13", "old-14"]);
  assert.deepEqual(covered.lines.slice(5), Array.from({ length: 11 }, (_, i) => `new-${15 + i}`));
});

test("truncateAfter discards edited range and following lines", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", startLine: 10, endLine: 40, lines: Array.from({ length: 31 }, (_, i) => `line-${10 + i}`) });
  store.truncateAfter("/tmp/a", 19);
  assert.deepEqual(store.covered("/tmp/a", 10, 19)?.lines, Array.from({ length: 10 }, (_, i) => `line-${10 + i}`));
  assert.equal(store.covered("/tmp/a", 20, 20), undefined);
  assert.equal(store.covered("/tmp/a", 10, 20), undefined);
});

test("invalidateRanges removes edited lines and preserves unaffected later snapshots", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", startLine: 1, endLine: 6, lines: ["1", "2", "3", "4", "5", "6"] });
  store.setColumns({ path: "/tmp/a", line: 6, startColumn: 1, endColumn: 1, text: "6", lineLength: 1 });
  store.invalidateRanges("/tmp/a", [{ startLine: 3, endLine: 4 }]);
  assert.deepEqual(store.covered("/tmp/a", 1, 2)?.lines, ["1", "2"]);
  assert.equal(store.covered("/tmp/a", 3, 3), undefined);
  assert.deepEqual(store.covered("/tmp/a", 5, 6)?.lines, ["5", "6"]);
  assert.ok(store.coveredColumns("/tmp/a", 6, 1, 1));
});

test("column snapshots tracked separately", () => {
  const store = new SnapshotStore();
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 10, endColumn: 20, text: "abcdefghijk", lineLength: 100 });
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 30, endColumn: 35, text: "uvwxyz", lineLength: 100 });
  assert.equal(store.covered("/tmp/a", 3, 3), undefined);
  assert.equal(store.coveredColumns("/tmp/a", 3, 12, 18)?.text, "abcdefghijk");
  assert.equal(store.coveredColumns("/tmp/a", 3, 31, 34)?.text, "uvwxyz");
  assert.equal(store.coveredColumns("/tmp/a", 3, 21, 29), undefined);
});

test("truncateAfter drops column snapshots after kept line", () => {
  const store = new SnapshotStore();
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 1, endColumn: 5, text: "abcde", lineLength: 20 });
  store.setColumns({ path: "/tmp/a", line: 5, startColumn: 1, endColumn: 5, text: "fghij", lineLength: 20 });
  store.truncateAfter("/tmp/a", 3);
  assert.ok(store.coveredColumns("/tmp/a", 3, 1, 5));
  assert.equal(store.coveredColumns("/tmp/a", 5, 1, 5), undefined);
});

test("overlapping column reread preserves old non-overlapping coverage", () => {
  const store = new SnapshotStore();
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 1, endColumn: 10, text: "abcdefghij", lineLength: 20 });
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 3, endColumn: 4, text: "XY", lineLength: 20 });
  assert.ok(store.coveredColumns("/tmp/a", 3, 1, 2));
  assert.ok(store.coveredColumns("/tmp/a", 3, 3, 4));
  assert.ok(store.coveredColumns("/tmp/a", 3, 5, 10));
  assert.deepEqual(store.columnRanges("/tmp/a"), [{ line: 3, startColumn: 1, endColumn: 10 }]);
});

test("adjacent column windows compose into wider coverage", () => {
  const store = new SnapshotStore();
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 1, endColumn: 4, text: "abcd", lineLength: 20 });
  store.setColumns({ path: "/tmp/a", line: 3, startColumn: 5, endColumn: 8, text: "efgh", lineLength: 20 });
  assert.ok(store.coveredColumns("/tmp/a", 3, 3, 6));
  assert.deepEqual(store.columnRanges("/tmp/a"), [{ line: 3, startColumn: 1, endColumn: 8 }]);
});


test("seedless invalidation retains and advances the file revision", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", startLine: 1, endLine: 1, lines: ["a"] });
  const before = store.revision("/tmp/a");
  store.invalidateRanges("/tmp/a", [{ startLine: 1, endLine: 1 }]);
  assert.ok(store.revision("/tmp/a") > before);
  assert.equal(store.covered("/tmp/a", 1, 1), undefined);

  const invalidated = store.revision("/tmp/a");
  store.truncateAfter("/tmp/a", 0);
  assert.ok(store.revision("/tmp/a") > invalidated);
});
