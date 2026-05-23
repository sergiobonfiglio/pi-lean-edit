import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore } from "../src/snapshot-store.ts";

test("non-overlapping reads accumulate", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", readAt: 1, startLine: 1, endLine: 2, lines: ["a", "b"], lineEnding: "\n" });
  store.set({ path: "/tmp/a", readAt: 2, startLine: 5, endLine: 5, lines: ["e"], lineEnding: "\n" });
  assert.deepEqual(store.covered("/tmp/a", 1, 2)?.lines, ["a", "b"]);
  assert.deepEqual(store.covered("/tmp/a", 5, 5)?.lines, ["e"]);
  assert.equal(store.covered("/tmp/a", 2, 5), undefined);
});

test("covered requires entire range", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", readAt: 1, startLine: 10, endLine: 12, lines: ["j", "k", "l"], lineEnding: "\n" });
  assert.equal(store.covered("/tmp/a", 9, 10), undefined);
  assert.equal(store.covered("/tmp/a", 12, 13), undefined);
  assert.ok(store.covered("/tmp/a", 10, 12));
});

test("overlapping reads keep older prefix and newer overlap/suffix", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", readAt: 1, startLine: 10, endLine: 20, lines: Array.from({ length: 11 }, (_, i) => `old-${10 + i}`), lineEnding: "\n" });
  store.set({ path: "/tmp/a", readAt: 2, startLine: 15, endLine: 25, lines: Array.from({ length: 11 }, (_, i) => `new-${15 + i}`), lineEnding: "\n" });

  const covered = store.covered("/tmp/a", 10, 25);
  assert.ok(covered);
  assert.deepEqual(covered.lines.slice(0, 5), ["old-10", "old-11", "old-12", "old-13", "old-14"]);
  assert.deepEqual(covered.lines.slice(5), Array.from({ length: 11 }, (_, i) => `new-${15 + i}`));
});

test("truncateAfter discards edited range and following lines", () => {
  const store = new SnapshotStore();
  store.set({ path: "/tmp/a", readAt: 1, startLine: 10, endLine: 40, lines: Array.from({ length: 31 }, (_, i) => `line-${10 + i}`), lineEnding: "\n" });
  store.truncateAfter("/tmp/a", 19);
  assert.deepEqual(store.covered("/tmp/a", 10, 19)?.lines, Array.from({ length: 10 }, (_, i) => `line-${10 + i}`));
  assert.equal(store.covered("/tmp/a", 20, 20), undefined);
  assert.equal(store.covered("/tmp/a", 10, 20), undefined);
});

test("column snapshots tracked separately", () => {
  const store = new SnapshotStore();
  store.setColumns({ path: "/tmp/a", readAt: 1, line: 3, startColumn: 10, endColumn: 20, text: "abcdefghijk", lineLength: 100, lineEnding: "\n", hugeLine: true });
  store.setColumns({ path: "/tmp/a", readAt: 2, line: 3, startColumn: 30, endColumn: 35, text: "uvwxyz", lineLength: 100, lineEnding: "\n", hugeLine: true });
  assert.equal(store.covered("/tmp/a", 3, 3), undefined);
  assert.equal(store.coveredColumns("/tmp/a", 3, 12, 18)?.text, "abcdefghijk");
  assert.equal(store.coveredColumns("/tmp/a", 3, 31, 34)?.text, "uvwxyz");
  assert.equal(store.coveredColumns("/tmp/a", 3, 21, 29), undefined);
});

test("truncateAfter drops column snapshots after kept line", () => {
  const store = new SnapshotStore();
  store.setColumns({ path: "/tmp/a", readAt: 1, line: 3, startColumn: 1, endColumn: 5, text: "abcde", lineLength: 20, lineEnding: "\n", hugeLine: true });
  store.setColumns({ path: "/tmp/a", readAt: 1, line: 5, startColumn: 1, endColumn: 5, text: "fghij", lineLength: 20, lineEnding: "\n", hugeLine: true });
  store.truncateAfter("/tmp/a", 3);
  assert.ok(store.coveredColumns("/tmp/a", 3, 1, 5));
  assert.equal(store.coveredColumns("/tmp/a", 5, 1, 5), undefined);
});
