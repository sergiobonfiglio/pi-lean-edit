import { promises as fs } from "node:fs";
import path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withInterprocessFileMutationLock } from "./file-mutation-lock.ts";
import { resolveCanonicalPath } from "./line-utils.ts";
export type LeanEditCounters = {
  attempts: number;
  failures: number;
  charsSaved: number;
  charsNormalEdit: number;
  charsLeanEdit: number;
};

export type LeanEditSnapshotTotals = LeanEditCounters & {
  failureRate: number;
  charsUsedRate: number;
  charsSavedRate: number;
};

export type LeanEditMetricsSnapshot = {
  session: LeanEditSnapshotTotals;
  global: LeanEditSnapshotTotals;
};

export type LeanEditDelta = LeanEditCounters;

const ZERO: LeanEditCounters = Object.freeze({ attempts: 0, failures: 0, charsSaved: 0, charsNormalEdit: 0, charsLeanEdit: 0 });

export function defaultMetricsPath(): string {
  return process.env.PI_LEAN_EDIT_METRICS_PATH || path.join(getAgentDir(), "pi-lean-edit", "metrics.json");
}

function clone(counters: LeanEditCounters): LeanEditCounters {
  return { ...counters };
}

function nonNegativeFinite(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function add(target: LeanEditCounters, delta: Partial<LeanEditDelta> | undefined): void {
  if (!delta) return;
  target.attempts += nonNegativeFinite(delta.attempts);
  target.failures += nonNegativeFinite(delta.failures);
  target.charsSaved += nonNegativeFinite(delta.charsSaved);
  target.charsNormalEdit += nonNegativeFinite(delta.charsNormalEdit);
  target.charsLeanEdit += nonNegativeFinite(delta.charsLeanEdit);
}

function snapshotTotals(counters: LeanEditCounters): LeanEditSnapshotTotals {
  const c = clone(counters);
  return {
    ...c,
    failureRate: c.attempts === 0 ? 0 : c.failures / c.attempts,
    charsUsedRate: c.charsNormalEdit === 0 ? 0 : c.charsLeanEdit / c.charsNormalEdit,
    charsSavedRate: c.charsNormalEdit === 0 ? 0 : c.charsSaved / c.charsNormalEdit
  };
}


export function failureDelta(): LeanEditDelta {
  return { attempts: 1, failures: 1, charsSaved: 0, charsNormalEdit: 0, charsLeanEdit: 0 };
}

export function getLeanEditDelta(details: any, toolName?: string, isError = false): LeanEditDelta {
  const delta = details?.leanEditMetrics?.delta;
  if (!delta) {
    const isLeanEdit = toolName === "edit" || toolName === "edit_huge_line";
    return isLeanEdit && isError ? failureDelta() : { ...ZERO };
  }
  return {
    attempts: nonNegativeFinite(delta.attempts),
    failures: nonNegativeFinite(delta.failures),
    charsSaved: nonNegativeFinite(delta.charsSaved),
    charsNormalEdit: nonNegativeFinite(delta.charsNormalEdit),
    charsLeanEdit: nonNegativeFinite(delta.charsLeanEdit)
  };
}

async function readCounters(metricsPath: string): Promise<LeanEditCounters> {
  try {
    const raw = JSON.parse(await fs.readFile(metricsPath, "utf8"));
    return {
      attempts: nonNegativeFinite(raw?.attempts),
      failures: nonNegativeFinite(raw?.failures),
      charsSaved: nonNegativeFinite(raw?.charsSaved),
      charsNormalEdit: nonNegativeFinite(raw?.charsNormalEdit),
      charsLeanEdit: nonNegativeFinite(raw?.charsLeanEdit)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return clone(ZERO);
    throw error;
  }
}

async function writeCounters(metricsPath: string, counters: LeanEditCounters): Promise<void> {
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  const tmp = `${metricsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(clone(counters), null, 2)}\n`, "utf8");
  await fs.rename(tmp, metricsPath);
}

export class LeanEditMetricsStore {
  private sessionCounters = clone(ZERO);
  private globalCounters = clone(ZERO);
  private writeQueue: Promise<void> = Promise.resolve();
  private metricsPath: string;

  constructor(metricsPath = defaultMetricsPath()) {
    this.metricsPath = metricsPath;
  }

  async loadGlobal(): Promise<void> {
    this.globalCounters = await readCounters(await resolveCanonicalPath(process.cwd(), this.metricsPath));
  }

  rebuildSession(branchEntries: any[]): void {
    this.sessionCounters = clone(ZERO);
    for (const entry of branchEntries) {
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "toolResult") continue;
      add(this.sessionCounters, getLeanEditDelta(message.details, message.toolName, message.isError));
    }
  }

  async record(delta: LeanEditDelta): Promise<LeanEditMetricsSnapshot> {
    add(this.sessionCounters, delta);
    const operation = this.writeQueue.then(async () => {
      const canonicalPath = await resolveCanonicalPath(process.cwd(), this.metricsPath);
      this.globalCounters = await withInterprocessFileMutationLock(canonicalPath, () => withFileMutationQueue(canonicalPath, async () => {
        const totals = await readCounters(canonicalPath);
        add(totals, delta);
        await writeCounters(canonicalPath, totals);
        return totals;
      }));
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return this.snapshot();
  }

  snapshot(): LeanEditMetricsSnapshot {
    return { session: snapshotTotals(this.sessionCounters), global: snapshotTotals(this.globalCounters) };
  }
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width, " ");
}

function statsRow(label: string, totals: LeanEditSnapshotTotals): string {
  return [
    pad(label, 7),
    pad(totals.attempts, 8),
    pad(`${totals.failures} (${formatPercent(totals.failureRate)})`, 17),
    pad(`${totals.charsLeanEdit}/${totals.charsNormalEdit}`, 13),
    formatPercent(totals.charsSavedRate)
  ].join("  ").trimEnd();
}

export function formatLeanEditStats(snapshot: LeanEditMetricsSnapshot): string {
  return [
    "lean edit stats",
    [pad("scope", 7), pad("attempts", 8), pad("failures", 17), pad("chars", 13), "saved"].join("  ").trimEnd(),
    statsRow("session", snapshot.session),
    statsRow("global", snapshot.global)
  ].join("\n");
}
