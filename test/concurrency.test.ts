import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import leanEditExtension from "../src/index.ts";
import { leanEdit } from "../src/edit-tool.ts";
import { leanRead } from "../src/read-tool.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

const workerPath = fileURLToPath(new URL("./fixtures/concurrency-worker.ts", import.meta.url));

type WorkerMessage = { type: string; ok?: boolean; stale?: boolean; message?: string };

function startWorker(env: NodeJS.ProcessEnv): ChildProcess {
  return fork(workerPath, [], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
}

function message(worker: ChildProcess, type: string, timeout = 5_000): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeout);
    const onMessage = (value: WorkerMessage) => {
      if (value?.type !== type) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(value);
    };
    worker.on("message", onMessage);
  });
}

function stop(worker: ChildProcess): void {
  if (worker.connected) worker.disconnect();
  if (!worker.killed) worker.kill();
}

async function waitForLock(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await fs.stat(`${file}.lock`).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("write wrapper did not acquire its inter-process lock");
}

async function tempFile(t: test.TestContext): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-concurrency-"));
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, "one\ntwo\n", "utf8");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file };
}

async function runCompetingEdits(t: test.TestContext, secondLine: number): Promise<{ file: string; first: WorkerMessage; second: WorkerMessage }> {
  const { dir, file } = await tempFile(t);
  const firstWorker = startWorker({ MODE: "edit", CWD: dir, FILE: file, LINE: "1", TEXT: "ONE-A", PAUSE_WRITE: "1" });
  t.after(() => stop(firstWorker));
  await message(firstWorker, "snapshotted");
  firstWorker.send({ type: "start" });
  await message(firstWorker, "entered-write");

  const secondWorker = startWorker({ MODE: "edit", CWD: dir, FILE: file, LINE: String(secondLine), TEXT: secondLine === 1 ? "ONE-B" : "TWO-B" });
  t.after(() => stop(secondWorker));
  await message(secondWorker, "snapshotted");
  secondWorker.send({ type: "start" });
  await assert.rejects(() => message(secondWorker, "entered-write", 150), /timed out/);

  const firstDone = message(firstWorker, "done");
  const secondDone = message(secondWorker, "done");
  firstWorker.send({ type: "release" });
  const [first, second] = await Promise.all([firstDone, secondDone]);
  return { file, first, second };
}

test("separate processes reject edits after any intervening file generation", async (t) => {
  const { file, first, second } = await runCompetingEdits(t, 2);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.stale, true);
  assert.match(second.message ?? "", /file changed since it was read/);
  assert.equal(await fs.readFile(file, "utf8"), "ONE-A\ntwo\n");
});

test("separate processes reject a stale competing lean edit", async (t) => {
  const { file, first, second } = await runCompetingEdits(t, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.stale, true);
  assert.match(second.message ?? "", /requested text changed since it was read/);
  assert.equal(await fs.readFile(file, "utf8"), "ONE-A\ntwo\n");
});

test("write wrapper and lean edit share lock ordering", async (t) => {
  const { dir, file } = await tempFile(t);
  const tools: Array<any> = [];
  leanEditExtension({
    registerTool: (tool: any) => { tools.push(tool); },
    registerCommand: () => {},
    on: () => {}
  } as any);
  const write = tools.find((tool) => tool.name === "write");
  assert.ok(write);

  const store = new SnapshotStore();
  const config = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 };
  await leanRead(dir, { path: file }, config, store);
  let releaseQueue!: () => void;
  let queueEntered!: () => void;
  const queueReady = new Promise<void>((resolve) => { queueEntered = resolve; });
  const queueRelease = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queueHolder = withFileMutationQueue(file, async () => { queueEntered(); await queueRelease; });
  await queueReady;

  const writeResult = write.execute("write", { path: file, content: "written\n" }, undefined, undefined, { cwd: dir });
  await waitForLock(file);
  const editResult = leanEdit(dir, { path: file, startLine: 1, newText: "edited" }, store, config);
  releaseQueue();
  await Promise.all([queueHolder, writeResult]);
  await assert.rejects(() => editResult, /requested text changed since it was read/);
  assert.equal(await fs.readFile(file, "utf8"), "written\n");
});

test("separate processes retain every metrics increment", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-metrics-concurrency-"));
  const metricsPath = path.join(dir, "metrics.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workers = Array.from({ length: 6 }, () => startWorker({ MODE: "metrics", METRICS_PATH: metricsPath }));
  for (const worker of workers) t.after(() => stop(worker));
  await Promise.all(workers.map((worker) => message(worker, "ready")));
  const done = workers.map((worker) => message(worker, "done"));
  for (const worker of workers) worker.send({ type: "start" });
  const results = await Promise.all(done);
  assert.ok(results.every((result) => result.ok));
  const counters = JSON.parse(await fs.readFile(metricsPath, "utf8"));
  assert.deepEqual(counters, { attempts: 6, failures: 0, charsSaved: 12, charsNormalEdit: 18, charsLeanEdit: 6 });
  assert.deepEqual((await fs.readdir(dir)).sort(), ["metrics.json"]);
});
