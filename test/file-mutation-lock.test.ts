import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withInterprocessFileMutationLock } from "../src/file-mutation-lock.ts";
import { resolveCanonicalPath } from "../src/line-utils.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function target(name = "file.txt"): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-lock-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, "text", "utf8");
  return { dir, file };
}

test("releases the lock after a callback throws", async () => {
  const { file } = await target();
  await assert.rejects(() => withInterprocessFileMutationLock(file, async () => { throw new Error("expected"); }), /expected/);
  await withInterprocessFileMutationLock(file, async () => {});
  await assert.rejects(() => fs.stat(`${file}.lock`), { code: "ENOENT" });
});

test("waiters proceed after the holder releases", async () => {
  const { file } = await target();
  let releaseHolder!: () => void;
  const holderEntered = new Promise<void>((resolve) => { releaseHolder = resolve; });
  let holderReady!: () => void;
  const holderReadyPromise = new Promise<void>((resolve) => { holderReady = resolve; });
  const holder = withInterprocessFileMutationLock(file, async () => {
    holderReady();
    await holderEntered;
  });
  await holderReadyPromise;
  let waiterEntered = false;
  const waiter = withInterprocessFileMutationLock(file, async () => { waiterEntered = true; });
  await delay(75);
  assert.equal(waiterEntered, false);
  releaseHolder();
  await Promise.all([holder, waiter]);
  assert.equal(waiterEntered, true);
});

test("different paths do not block each other", async () => {
  const { dir, file } = await target();
  const other = path.join(dir, "other.txt");
  await fs.writeFile(other, "other", "utf8");
  let firstEntered!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
  let releaseFirst!: () => void;
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withInterprocessFileMutationLock(file, async () => { firstEntered(); await release; });
  await firstReady;
  let secondEntered = false;
  await withInterprocessFileMutationLock(other, async () => { secondEntered = true; });
  assert.equal(secondEntered, true);
  releaseFirst();
  await first;
});

test("canonical symlink aliases share a lock", async () => {
  const { dir, file } = await target();
  const alias = path.join(dir, "alias.txt");
  await fs.symlink(file, alias);
  const canonical = await resolveCanonicalPath(dir, file);
  const canonicalAlias = await resolveCanonicalPath(dir, alias);
  assert.equal(canonicalAlias, canonical);

  let releaseFirst!: () => void;
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstEntered!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
  const first = withInterprocessFileMutationLock(canonical, async () => { firstEntered(); await release; });
  await firstReady;
  let aliasEntered = false;
  const second = withInterprocessFileMutationLock(canonicalAlias, async () => { aliasEntered = true; });
  await delay(75);
  assert.equal(aliasEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(aliasEntered, true);
});

test("reclaims a stale lock left by a crashed process", async () => {
  const { file } = await target();
  const staleLock = `${file}.lock`;
  await fs.mkdir(staleLock);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(staleLock, old, old);
  await withInterprocessFileMutationLock(file, async () => {});
  await assert.rejects(() => fs.stat(staleLock), { code: "ENOENT" });
});
