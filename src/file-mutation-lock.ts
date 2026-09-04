import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;
const RETRIES = 100;

type LockOptions = {
  signal?: AbortSignal;
  onCleanupError?: (error: unknown) => void;
};

type LockDeps = {
  lock?: typeof lockfile.lock;
};

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireLock(canonicalPath: string, signal: AbortSignal | undefined, lock: typeof lockfile.lock): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await lock(canonicalPath, {
        realpath: false,
        stale: STALE_MS,
        update: UPDATE_MS,
        retries: 0
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= RETRIES) throw error;
      const delay = Math.min(500, 25 * 1.2 ** attempt) * (0.5 + Math.random());
      await abortableDelay(delay, signal);
    }
  }
}

/**
 * Serializes cooperating local processes that mutate the same canonical path.
 * This does not coordinate direct filesystem writes or tools that do not use it.
 */
export async function withInterprocessFileMutationLock<T>(
  canonicalPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
  deps: LockDeps = {}
): Promise<T> {
  throwIfAborted(options.signal);
  // `proper-lockfile` uses an adjacent directory, so a new write target needs
  // its parent before the lock can be acquired.
  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  const release = await acquireLock(canonicalPath, options.signal, deps.lock ?? lockfile.lock);

  try {
    throwIfAborted(options.signal);
  } catch (error) {
    try {
      await release();
    } catch {
      // No mutation ran, so preserve the cancellation as the useful failure.
    }
    throw error;
  }

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
      if (!callbackFailed) options.onCleanupError?.(error);
    }
  }
}
