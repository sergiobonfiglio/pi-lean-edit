import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultMetricsPath, failureDelta, formatLeanEditStats, LeanEditMetricsStore } from "../src/metrics.ts";

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
  const snapshot = await store.record({ attempts: 1, failures: 0, charsNormalEdit: 11, charsLeanEdit: 7, charsSaved: 4 });
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
  await first.record({ attempts: 1, failures: 0, charsNormalEdit: 7, charsLeanEdit: 3, charsSaved: 4 });

  const second = new LeanEditMetricsStore(metricsPath);
  await second.loadGlobal();
  const snapshot = second.snapshot();
  assert.equal(snapshot.global.attempts, 1);
  assert.equal(snapshot.global.charsSaved, 4);
});

test("same-process concurrent metric updates do not lose increments", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const store = new LeanEditMetricsStore(metricsPath);
  await store.loadGlobal();
  const delta = { attempts: 1, failures: 0, charsNormalEdit: 3, charsLeanEdit: 1, charsSaved: 2 };
  await Promise.all(Array.from({ length: 5 }, () => store.record(delta)));
  assert.deepEqual(JSON.parse(await fs.readFile(metricsPath, "utf8")), {
    attempts: 5,
    failures: 0,
    charsSaved: 10,
    charsNormalEdit: 15,
    charsLeanEdit: 5
  });
});
test("session metrics rebuild from tool result details", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const store = new LeanEditMetricsStore(metricsPath);
  store.rebuildSession([{ type: "message", message: { role: "toolResult", toolName: "edit", details: { leanEditMetrics: { delta: failureDelta() } } } }]);
  assert.equal(store.snapshot().session.attempts, 1);
  assert.equal(store.snapshot().session.failures, 1);
});

test("session metrics rebuild failed edit results without details", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  const store = new LeanEditMetricsStore(metricsPath);
  store.rebuildSession([
    { type: "message", message: { role: "toolResult", toolName: "edit", isError: true } },
    { type: "message", message: { role: "toolResult", toolName: "edit_huge_line", isError: true } },
    { type: "message", message: { role: "toolResult", toolName: "read", isError: true } }
  ]);
  assert.equal(store.snapshot().session.attempts, 2);
  assert.equal(store.snapshot().session.failures, 2);
});

test("default metrics path follows PI_CODING_AGENT_DIR", () => {
  const previousMetrics = process.env.PI_LEAN_EDIT_METRICS_PATH;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_LEAN_EDIT_METRICS_PATH;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
  try {
    assert.equal(defaultMetricsPath(), "/tmp/custom-pi-agent/pi-lean-edit/metrics.json");
  } finally {
    if (previousMetrics == null) delete process.env.PI_LEAN_EDIT_METRICS_PATH;
    else process.env.PI_LEAN_EDIT_METRICS_PATH = previousMetrics;
    if (previousAgent == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  }
});

test("malformed numeric metric fields normalize to zero", async () => {
  const metricsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-")), "metrics.json");
  await fs.writeFile(metricsPath, JSON.stringify({
    attempts: "invalid",
    failures: null,
    charsSaved: "Infinity",
    charsNormalEdit: -5,
    charsLeanEdit: 2
  }));
  const store = new LeanEditMetricsStore(metricsPath);
  await store.loadGlobal();
  assert.deepEqual(store.snapshot().global, {
    attempts: 0,
    failures: 0,
    charsSaved: 0,
    charsNormalEdit: 0,
    charsLeanEdit: 2,
    failureRate: 0,
    charsUsedRate: 0,
    charsSavedRate: 0
  });
  await store.record({ attempts: 1, failures: 0, charsSaved: 1, charsNormalEdit: 2, charsLeanEdit: 1 });
  const persisted = JSON.parse(await fs.readFile(metricsPath, "utf8"));
  assert.deepEqual(persisted, { attempts: 1, failures: 0, charsSaved: 1, charsNormalEdit: 2, charsLeanEdit: 3 });
});
