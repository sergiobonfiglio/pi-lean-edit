import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { failureDelta, formatLeanEditStats, LeanEditMetricsStore, successDelta } from "../src/metrics.ts";

test("failure metrics increment", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const store = new LeanEditMetricsStore(metricsPath);
  await store.loadGlobal();
  const snapshot = await store.record(failureDelta());
  assert.equal(snapshot.session.attempts, 1);
  assert.equal(snapshot.session.failures, 1);
  assert.equal(snapshot.session.failureRate, 1);
});

test("saved-character metrics increment on success", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const store = new LeanEditMetricsStore(metricsPath);
  await store.loadGlobal();
  const snapshot = await store.record(successDelta("old text", "new", 10, 12));
  assert.equal(snapshot.session.attempts, 1);
  assert.equal(snapshot.session.failures, 0);
  assert.equal(snapshot.session.charsNormalEdit, 11);
  assert.equal(snapshot.session.charsLeanEdit, 7);
  assert.equal(snapshot.session.charsSaved, 4);
  assert.equal(snapshot.session.charsUsedRate, 7 / 11);
  assert.equal(snapshot.session.charsSavedRate, 4 / 11);
});

test("stats output table shows saved rate", () => {
  const text = formatLeanEditStats({
    session: { attempts: 1, failures: 0, failureRate: 0, charsLeanEdit: 39, charsNormalEdit: 100, charsSaved: 61, charsUsedRate: 0.39, charsSavedRate: 0.61 },
    global: { attempts: 1, failures: 0, failureRate: 0, charsLeanEdit: 39, charsNormalEdit: 100, charsSaved: 61, charsUsedRate: 0.39, charsSavedRate: 0.61 }
  });
  assert.match(text, /scope\s+attempts\s+failures\s+chars\s+saved/);
  assert.doesNotMatch(text, /used/);
  assert.match(text, /session\s+1\s+0 \(0\.0%\)\s+39\/100\s+61\.0%/);
});

test("global metrics persist across extension reload", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const first = new LeanEditMetricsStore(metricsPath);
  await first.loadGlobal();
  await first.record(successDelta("abcdef", "x", 1, 1));

  const second = new LeanEditMetricsStore(metricsPath);
  await second.loadGlobal();
  const snapshot = second.snapshot();
  assert.equal(snapshot.global.attempts, 1);
  assert.equal(snapshot.global.charsSaved, 4);
});

test("session metrics rebuild from tool result details", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const store = new LeanEditMetricsStore(metricsPath);
  store.rebuildSession([{ type: "message", message: { role: "toolResult", toolName: "edit", details: { leanEditMetrics: { delta: failureDelta() } } } }]);
  assert.equal(store.snapshot().session.attempts, 1);
  assert.equal(store.snapshot().session.failures, 1);
});
