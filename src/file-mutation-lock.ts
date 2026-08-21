import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;

/**
 * Serializes cooperating local processes that mutate the same canonical path.
 * This does not coordinate direct filesystem writes or tools that do not use it.
 */
export async function withInterprocessFileMutationLock<T>(canonicalPath: string, fn: () => Promise<T>): Promise<T> {
  // `proper-lockfile` uses an adjacent directory, so a new write target needs
  // its parent before the lock can be acquired.
  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  const release = await lockfile.lock(canonicalPath, {
    realpath: false,
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: { retries: 100, factor: 1.2, minTimeout: 25, maxTimeout: 500, randomize: true }
  });

  let callbackFailed = false;
  try {
    return await fn();
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (!callbackFailed) throw error;
    }
  }
}
