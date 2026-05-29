import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type SmartEditCounters = {
  attempts: number;
  failures: number;
  charsSaved: number;
  charsNormalEdit: number;
  charsSmartEdit: number;
};

export type SmartEditSnapshotTotals = SmartEditCounters & {
  failureRate: number;
  charsUsedRate: number;
  charsSavedRate: number;
};

export type SmartEditMetricsSnapshot = {
  session: SmartEditSnapshotTotals;
  global: SmartEditSnapshotTotals;
};

export type SmartEditDelta = {
  attempts: number;
  failures: number;
  charsSaved: number;
  charsNormalEdit: number;
  charsSmartEdit: number;
};

const ZERO: SmartEditCounters = Object.freeze({ attempts: 0, failures: 0, charsSaved: 0, charsNormalEdit: 0, charsSmartEdit: 0 });

export function defaultMetricsPath(): string {
  return process.env.PI_LEAN_EDIT_METRICS_PATH || path.join(os.homedir(), ".pi", "agent", "pi-lean-edit", "metrics.json");
}

function clone(counters: SmartEditCounters): SmartEditCounters {
  return {
    attempts: counters.attempts,
    failures: counters.failures,
    charsSaved: counters.charsSaved,
    charsNormalEdit: counters.charsNormalEdit,
    charsSmartEdit: counters.charsSmartEdit
  };
}

function add(target: SmartEditCounters, delta: Partial<SmartEditDelta> | undefined): void {
  if (!delta) return;
  target.attempts += Math.max(0, Number(delta.attempts ?? 0));
  target.failures += Math.max(0, Number(delta.failures ?? 0));
  target.charsSaved += Math.max(0, Number(delta.charsSaved ?? 0));
  target.charsNormalEdit += Math.max(0, Number(delta.charsNormalEdit ?? 0));
  target.charsSmartEdit += Math.max(0, Number(delta.charsSmartEdit ?? 0));
}

function snapshotTotals(counters: SmartEditCounters): SmartEditSnapshotTotals {
  const c = clone(counters);
  return {
    ...c,
    failureRate: c.attempts === 0 ? 0 : c.failures / c.attempts,
    charsUsedRate: c.charsNormalEdit === 0 ? 0 : c.charsSmartEdit / c.charsNormalEdit,
    charsSavedRate: c.charsNormalEdit === 0 ? 0 : c.charsSaved / c.charsNormalEdit
  };
}

export function successDelta(oldText: string, newText: string, startLine: number, endLine: number): SmartEditDelta {
  const charsNormalEdit = oldText.length + newText.length;
  const charsSmartEdit = String(startLine).length + String(endLine).length + newText.length;
  const charsSaved = Math.max(0, charsNormalEdit - charsSmartEdit);
  return { attempts: 1, failures: 0, charsSaved, charsNormalEdit, charsSmartEdit };
}

export function failureDelta(): SmartEditDelta {
  return { attempts: 1, failures: 1, charsSaved: 0, charsNormalEdit: 0, charsSmartEdit: 0 };
}

export function getSmartEditDelta(details: any, toolName?: string): SmartEditDelta {
  const delta = details?.smartEditMetrics?.delta;
  if (!delta && toolName !== "edit") return { ...ZERO };
  return {
    attempts: Math.max(0, Number(delta?.attempts ?? 0)),
    failures: Math.max(0, Number(delta?.failures ?? 0)),
    charsSaved: Math.max(0, Number(delta?.charsSaved ?? 0)),
    charsNormalEdit: Math.max(0, Number(delta?.charsNormalEdit ?? 0)),
    charsSmartEdit: Math.max(0, Number(delta?.charsSmartEdit ?? 0))
  };
}

async function readCounters(metricsPath: string): Promise<SmartEditCounters> {
  try {
    const raw = JSON.parse(await fs.readFile(metricsPath, "utf8"));
    return {
      attempts: Math.max(0, Number(raw?.attempts ?? 0)),
      failures: Math.max(0, Number(raw?.failures ?? 0)),
      charsSaved: Math.max(0, Number(raw?.charsSaved ?? 0)),
      charsNormalEdit: Math.max(0, Number(raw?.charsNormalEdit ?? 0)),
      charsSmartEdit: Math.max(0, Number(raw?.charsSmartEdit ?? 0))
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return clone(ZERO);
    throw error;
  }
}

async function writeCounters(metricsPath: string, counters: SmartEditCounters): Promise<void> {
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  const tmp = `${metricsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(clone(counters), null, 2)}\n`, "utf8");
  await fs.rename(tmp, metricsPath);
}

export class SmartEditMetricsStore {
  private sessionCounters = clone(ZERO);
  private globalCounters = clone(ZERO);
  private writeQueue: Promise<void> = Promise.resolve();
  private metricsPath: string;

  constructor(metricsPath = defaultMetricsPath()) {
    this.metricsPath = metricsPath;
  }

  async loadGlobal(): Promise<void> {
    this.globalCounters = await readCounters(this.metricsPath);
  }

  rebuildSession(branchEntries: any[]): void {
    this.sessionCounters = clone(ZERO);
    for (const entry of branchEntries) {
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "toolResult") continue;
      add(this.sessionCounters, getSmartEditDelta(message.details, message.toolName));
    }
  }

  async record(delta: SmartEditDelta): Promise<SmartEditMetricsSnapshot> {
    add(this.sessionCounters, delta);
    this.writeQueue = this.writeQueue.then(async () => {
      this.globalCounters = await withFileMutationQueue(this.metricsPath, async () => {
        const totals = await readCounters(this.metricsPath);
        add(totals, delta);
        await writeCounters(this.metricsPath, totals);
        return totals;
      });
    });
    await this.writeQueue;
    return this.snapshot();
  }

  snapshot(): SmartEditMetricsSnapshot {
    return { session: snapshotTotals(this.sessionCounters), global: snapshotTotals(this.globalCounters) };
  }
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width, " ");
}

function statsRow(label: string, totals: SmartEditSnapshotTotals): string {
  return [
    pad(label, 7),
    pad(totals.attempts, 8),
    pad(`${totals.failures} (${formatPercent(totals.failureRate)})`, 17),
    pad(`${totals.charsSmartEdit}/${totals.charsNormalEdit}`, 13),
    formatPercent(totals.charsSavedRate)
  ].join("  ").trimEnd();
}

export function formatSmartEditStats(snapshot: SmartEditMetricsSnapshot): string {
  return [
    "smart edit stats",
    [pad("scope", 7), pad("attempts", 8), pad("failures", 17), pad("chars", 13), "saved"].join("  ").trimEnd(),
    statsRow("session", snapshot.session),
    statsRow("global", snapshot.global)
  ].join("\n");
}
