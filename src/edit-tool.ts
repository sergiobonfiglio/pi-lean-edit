import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withInterprocessFileMutationLock } from "./file-mutation-lock.ts";
import { firstChangedLine, unifiedDiff } from "./diff.ts";
import { formatNumberedLines, hasMixedLineEndings, joinText, rangeText, replacementLines, resolveCanonicalPath, sliceRange, splitText, type SplitText } from "./line-utils.ts";
import { SnapshotStore, snapshotStore } from "./snapshot-store.ts";
import { type LeanEditDelta } from "./metrics.ts";

export type LineEditRange = {
  startLine: number;
  endLine?: number;
  newText: string;
};

export type LeanEditInput = ({ path: string; edits?: never } & LineEditRange) | CanonicalLeanEditInput;

const leanEditRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 1, description: "First line to replace (1-based, inclusive)" }),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to replace (1-based, inclusive). Defaults to startLine." })),
  newText: Type.String({ description: "Replacement text. Empty string deletes the range." })
}, { additionalProperties: false });

export const leanEditSchema = Type.Object({
  path: Type.String({ description: "Path to edit, relative to cwd unless absolute" }),
  edits: Type.Array(leanEditRangeSchema, {
    minItems: 1,
    description: "One or more non-overlapping full-line edits for this file. Use one item for a single edit."
  })
}, { additionalProperties: false });
export type CanonicalLeanEditInput = Static<typeof leanEditSchema>;

/** Convert the former direct single-line-range form before provider schema validation. */
export function prepareLeanEditArguments(input: unknown): CanonicalLeanEditInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input as CanonicalLeanEditInput;
  const args = input as Record<string, unknown>;
  const rangeFields = ["startLine", "endLine", "newText"];
  if (args.edits !== undefined) {
    if ([...rangeFields, "startColumn", "endColumn"].some((field) => field in args)) throw new Error("cannot combine top-level range fields with edits[]");
    return input as CanonicalLeanEditInput;
  }
  if ("startColumn" in args || "endColumn" in args) throw new Error("column edits require edit_huge_line");
  if (args.startLine === undefined) return input as CanonicalLeanEditInput;

  const { startLine, endLine, newText, ...rest } = args;
  return {
    ...rest,
    edits: [{
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
      ...(newText !== undefined ? { newText } : {})
    }]
  } as CanonicalLeanEditInput;
}

type NormalizedEdit = {
  startLine: number;
  endLine: number;
  newText: string;
};

export type LeanEditResult = {
  text: string;
  diff: string;
  firstChangedLine?: number;
  delta: LeanEditDelta;
  warning?: string;
};

export type LeanEditConfig = {
  maxLines: number;
  maxBytes: number;
};

export class StaleEditError extends Error {
  readonly refreshedText: string;

  constructor(refreshedText: string, reason: string) {
    super(`edit not applied: ${reason}.`);
    this.name = "StaleEditError";
    this.refreshedText = refreshedText;
  }
}

function validateRange(startLine: number, endLine: number): void {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) throw new Error("startLine/endLine must be integers");
  if (startLine < 1 || endLine < 1) throw new Error("startLine/endLine must be >= 1");
  if (endLine < startLine) throw new Error("endLine must be >= startLine");
}

function normalizeEdits(input: CanonicalLeanEditInput): NormalizedEdit[] {
  if (!Array.isArray(input.edits)) throw new Error("edit requires edits[]");
  if (input.edits.length === 0) throw new Error("edits must contain at least one range");
  const edits = input.edits.map((edit) => {
    if ("startColumn" in edit || "endColumn" in edit) throw new Error("column edits require edit_huge_line");
    if (edit.startLine == null || edit.newText == null) throw new Error("each edit requires startLine and newText");
    const normalized = { startLine: edit.startLine, endLine: edit.endLine ?? edit.startLine, newText: edit.newText };
    validateRange(normalized.startLine, normalized.endLine);
    return normalized;
  });
  edits.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i]!.startLine <= edits[i - 1]!.endLine) throw new Error("edit ranges must not overlap");
  }
  return edits;
}

function snapshotMatches(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((line, index) => line === actual[index]);
}

function editAddressSize(edit: NormalizedEdit): number {
  return `${edit.startLine}${edit.endLine}`.length;
}

function successDelta(parts: Array<{ oldText: string; edit: NormalizedEdit }>): LeanEditDelta {
  const charsNormalEdit = parts.reduce((sum, part) => sum + part.oldText.length + part.edit.newText.length, 0);
  const charsLeanEdit = parts.reduce((sum, part) => sum + editAddressSize(part.edit) + part.edit.newText.length, 0);
  return { attempts: 1, failures: 0, charsSaved: Math.max(0, charsNormalEdit - charsLeanEdit), charsNormalEdit, charsLeanEdit };
}

function refreshStaleRanges(store: SnapshotStore, path: string, edits: NormalizedEdit[], parsed: SplitText, config: LeanEditConfig): string | undefined {
  const contextLines = 5;
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  for (const edit of edits) {
    const range = {
      startLine: Math.max(1, edit.startLine - contextLines),
      endLine: Math.min(parsed.lines.length, edit.endLine + contextLines)
    };
    const previous = ranges.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else ranges.push(range);
  }

  const entries = ranges.map((range) => {
    const lines = sliceRange(parsed.lines, range.startLine, range.endLine);
    return { ...range, lines, text: formatNumberedLines(lines, range.startLine) };
  });
  const text = entries.map((entry) => entry.text).join("\n");
  if ((text ? text.split("\n").length : 0) > config.maxLines || Buffer.byteLength(text, "utf8") > config.maxBytes) return undefined;
  for (const entry of entries) {
    store.set({ path, startLine: entry.startLine, endLine: entry.endLine, lines: entry.lines });
  }
  return text;
}

function keepsSameLineCount(edit: NormalizedEdit): boolean {
  return replacementLines(edit.newText).length === edit.endLine - edit.startLine + 1;
}

function invalidateSnapshotsAfterEdit(store: SnapshotStore, path: string, edits: NormalizedEdit[]): void {
  const firstLineCountChange = edits.find((edit) => !keepsSameLineCount(edit));
  if (!firstLineCountChange) {
    store.invalidateRanges(path, edits.map(({ startLine, endLine }) => ({ startLine, endLine })));
    return;
  }
  store.truncateAfter(path, firstLineCountChange.startLine - 1);
  const preservedPrefixEdits = edits
    .filter((edit) => edit.endLine < firstLineCountChange.startLine)
    .map(({ startLine, endLine }) => ({ startLine, endLine }));
  if (preservedPrefixEdits.length) store.invalidateRanges(path, preservedPrefixEdits);
}

function reseedReplacements(store: SnapshotStore, path: string, edits: NormalizedEdit[]): void {
  let lineDelta = 0;
  for (const edit of edits) {
    const lines = replacementLines(edit.newText);
    if (lines.length > 0) {
      const startLine = edit.startLine + lineDelta;
      store.set({ path, startLine, endLine: startLine + lines.length - 1, lines });
    }
    lineDelta += lines.length - (edit.endLine - edit.startLine + 1);
  }
}

export async function leanEdit(
  cwd: string,
  input: LeanEditInput,
  store: SnapshotStore = snapshotStore,
  config: LeanEditConfig = { maxLines: 2000, maxBytes: 50_000 },
  signal?: AbortSignal
): Promise<LeanEditResult> {
  signal?.throwIfAborted();
  const prepared = prepareLeanEditArguments(input);
  const invocationRevision = store.revision();
  const edits = normalizeEdits(prepared);
  const full = await resolveCanonicalPath(cwd, prepared.path);
  signal?.throwIfAborted();
  if (store.revision(full) > invocationRevision) throw new Error("file stale, read again: snapshot changed while edit was starting");
  const initialSnapshots = edits.map((edit) => store.covered(full, edit.startLine, edit.endLine));
  const initialRevision = store.revision(full);
  let cleanupWarning: string | undefined;

  const result = await withInterprocessFileMutationLock(full, () => withFileMutationQueue(full, async () => {
    signal?.throwIfAborted();
    if (store.revision(full) !== initialRevision) throw new Error("file stale, read again: snapshot changed while edit was queued");
    const before = await fs.readFile(full, "utf8");
    signal?.throwIfAborted();
    if (hasMixedLineEndings(before)) throw new Error("cannot safely edit a file with mixed line endings");
    const parsed = splitText(before);
    const parts: Array<{ oldText: string; edit: NormalizedEdit }> = [];
    let missingCoverage = false;
    let changedCoverage = false;

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      if (edit.endLine > parsed.lines.length) throw new Error("file stale, read again: requested range is beyond end of file");
      const actual = sliceRange(parsed.lines, edit.startLine, edit.endLine);
      const snapshot = initialSnapshots[i];
      if (!snapshot) missingCoverage = true;
      else if (!snapshotMatches(snapshot.lines, actual)) changedCoverage = true;
      parts.push({ oldText: rangeText(parsed.lines, edit.startLine, edit.endLine, parsed.lineEnding), edit });
    }

    if (missingCoverage || changedCoverage) {
      const refreshedText = refreshStaleRanges(store, full, edits, parsed, config);
      if (refreshedText == null) throw new Error("file stale, read again: updated range exceeds automatic refresh limits");
      const reason = missingCoverage && changedCoverage
        ? "one or more requested ranges were not read beforehand, and other requested text changed since it was read"
        : missingCoverage
          ? "one or more requested ranges were not read beforehand"
          : "the requested text changed since it was read";
      throw new StaleEditError(refreshedText, reason);
    }

    const nextLines = [...parsed.lines];
    for (const edit of [...edits].reverse()) {
      nextLines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines(edit.newText));
    }
    const hasFinalEmptyReplacementRow = edits.some((edit) => edit.endLine === parsed.lines.length && /[\r\n]$/.test(edit.newText));
    const after = joinText(nextLines, parsed.lineEnding, parsed.finalNewline || hasFinalEmptyReplacementRow);
    signal?.throwIfAborted();
    await fs.writeFile(full, after, "utf8");
    invalidateSnapshotsAfterEdit(store, full, edits);
    reseedReplacements(store, full, edits);

    const labels = edits.map((edit) => edit.startLine === edit.endLine ? `${edit.startLine}` : `${edit.startLine}-${edit.endLine}`).join(",");
    return {
      text: `Applied edit to ${prepared.path}:${labels}`,
      diff: unifiedDiff(prepared.path, before, after),
      firstChangedLine: firstChangedLine(before, after),
      delta: successDelta(parts)
    };
  }), {
    signal,
    onCleanupError: (error) => {
      cleanupWarning = `Warning: Edit was applied, but the file lock could not be released cleanly: ${error instanceof Error ? error.message : String(error)}. Do not retry the edit blindly.`;
    }
  });

  return cleanupWarning ? { ...result, warning: cleanupWarning } : result;
}
