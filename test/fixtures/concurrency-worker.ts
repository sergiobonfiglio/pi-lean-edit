import { promises as fs } from "node:fs";
import { leanEdit, StaleEditError } from "../../src/edit-tool.ts";
import { LeanEditMetricsStore } from "../../src/metrics.ts";
import { leanRead } from "../../src/read-tool.ts";
import { SnapshotStore } from "../../src/snapshot-store.ts";

const config = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 };

type Message = { type?: string };

function send(type: string, extra: Record<string, unknown> = {}): void {
  process.send?.({ type, ...extra });
}

function waitFor(type: string): Promise<void> {
  return new Promise((resolve) => {
    process.on("message", (message: Message) => {
      if (message?.type === type) resolve();
    });
  });
}

async function runEdit(): Promise<void> {
  const file = process.env.FILE!;
  const cwd = process.env.CWD!;
  const store = new SnapshotStore();
  await leanRead(cwd, { path: file }, config, store);
  send("snapshotted");
  await waitFor("start");

  if (process.env.PAUSE_WRITE === "1") {
    const writableFs = fs as typeof fs & { writeFile: (...args: any[]) => Promise<void> };
    const originalWriteFile = writableFs.writeFile.bind(fs);
    writableFs.writeFile = async (...args: any[]) => {
      send("entered-write");
      await waitFor("release");
      return originalWriteFile(...args);
    };
  } else {
    const writableFs = fs as typeof fs & { writeFile: (...args: any[]) => Promise<void> };
    const originalWriteFile = writableFs.writeFile.bind(fs);
    writableFs.writeFile = async (...args: any[]) => {
      send("entered-write");
      return originalWriteFile(...args);
    };
  }

  try {
    await leanEdit(cwd, { path: file, startLine: Number(process.env.LINE), newText: process.env.TEXT! }, store, config);
    send("done", { ok: true });
  } catch (error) {
    send("done", {
      ok: false,
      stale: error instanceof StaleEditError,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runMetrics(): Promise<void> {
  send("ready");
  await waitFor("start");
  const store = new LeanEditMetricsStore(process.env.METRICS_PATH!);
  await store.record({ attempts: 1, failures: 0, charsSaved: 2, charsNormalEdit: 3, charsLeanEdit: 1 });
  send("done", { ok: true });
}

void (process.env.MODE === "metrics" ? runMetrics() : runEdit()).catch((error) => {
  send("done", { ok: false, message: error instanceof Error ? error.message : String(error) });
});
