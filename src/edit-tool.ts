import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withInterprocessFileMutationLock } from "./file-mutation-lock.ts";
import { firstChangedLine, unifiedDiff } from "./diff.ts";
import { codePointLength, formatColumnLine, formatNumberedLines, joinText, rangeText, replaceColumns, replacementLines, resolveCanonicalPath, sliceColumns, sliceRange, splitText, type SplitText } from "./line-utils.ts";
import { type ColumnSnapshot, type SnapshotStore, snapshotStore } from "./snapshot-store.ts";
import { type LeanEditDelta, type LeanEditMetricsSnapshot } from "./metrics.ts";

export type LineEditRange = {
  startLine: number;
  endLine?: number;
  startColumn?: never;
  endColumn?: never;
  newText: string;
};

export type ColumnEditRange = {
  startLine: number;
  endLine?: never;
  startColumn: number;
  endColumn: number;
  newText: string;
};

export type LeanEditRange = LineEditRange | ColumnEditRange;
export type LeanEditInput = ({ path: string; edits?: never } & LeanEditRange) | CanonicalLeanEditInput;

// Keep the provider-facing schema as one plain object. Cross-field invariants such
// as paired columns and line-vs-column ranges are enforced by normalizeEdits().
const leanEditRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 1, description: "First line to replace (1-based, inclusive)" }),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to replace (1-based, inclusive). Defaults to startLine." })),
  startColumn: Type.Optional(Type.Integer({ minimum: 1, description: "First column to replace (1-based, inclusive). Must be provided with endColumn and without endLine." })),
  endColumn: Type.Optional(Type.Integer({ minimum: 1, description: "Last column to replace (1-based, inclusive). Must be provided with startColumn and without endLine." })),
  newText: Type.String({ description: "Replacement text. Empty string deletes the range; column replacements may contain newlines." })
}, { additionalProperties: false });

export const leanEditSchema = Type.Object({
  path: Type.String({ description: "Path to edit, relative to cwd unless absolute" }),
  edits: Type.Array(leanEditRangeSchema, {
    minItems: 1,
    description: "One or more non-overlapping line or single-line column edits for this file. Use one item for a single edit."
  })
}, { additionalProperties: false });
export type CanonicalLeanEditInput = Static<typeof leanEditSchema>;

/** Convert the former direct single-range form before provider schema validation. */
export function prepareLeanEditArguments(input: unknown): CanonicalLeanEditInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input as CanonicalLeanEditInput;
  const args = input as Record<string, unknown>;
  if (args.edits !== undefined || args.startLine === undefined) return input as CanonicalLeanEditInput;

  const { startLine, endLine, startColumn, endColumn, newText, ...rest } = args;
  return {
    ...rest,
    edits: [{
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
      ...(startColumn !== undefined ? { startColumn } : {}),
      ...(endColumn !== undefined ? { endColumn } : {}),
      ...(newText !== undefined ? { newText } : {})
    }]
  } as CanonicalLeanEditInput;
}

type UnvalidatedEditRange = {
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  newText?: string;
};

type NormalizedEdit = {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  newText: string;
};

type SnapshotCoverage =
  | { kind: "full-line"; lines: string[] }
  | { kind: "column"; snapshot: ColumnSnapshot };

type PostEditSeed =
  | { kind: "full-line"; startLine: number; lines: string[] }
  | { kind: "column"; line: number; startColumn: number; endColumn: number; text: string };

type SymbolicPiece =
  | { kind: "known"; text: string }
  | { kind: "unknown"; length?: number };

export type LeanEditResult = {
  text: string;
  diff: string;
  firstChangedLine?: number;
  delta: LeanEditDelta;
  metrics?: LeanEditMetricsSnapshot;
};

export type LeanEditConfig = {
  maxLines: number;
  maxBytes: number;
  maxColumns?: number;
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

function validateColumns(edit: NormalizedEdit): void {
  const hasStart = edit.startColumn != null;
  const hasEnd = edit.endColumn != null;
  if (hasStart !== hasEnd) throw new Error("startColumn and endColumn must be provided together");
  if (!hasStart) return;
  if (edit.endLine !== edit.startLine) throw new Error("column edits must stay within one line");
  if (!Number.isInteger(edit.startColumn) || !Number.isInteger(edit.endColumn)) throw new Error("startColumn/endColumn must be integers");
  if (edit.startColumn! < 1 || edit.endColumn! < 1) throw new Error("startColumn/endColumn must be >= 1");
  if (edit.endColumn! < edit.startColumn!) throw new Error("endColumn must be >= startColumn");
}

function normalizeEdits(input: LeanEditInput): NormalizedEdit[] {
  const unvalidated = input as unknown as UnvalidatedEditRange & { edits?: UnvalidatedEditRange[] };
  let rawEdits: UnvalidatedEditRange[];
  if (Array.isArray(unvalidated.edits)) {
    if ([unvalidated.startLine, unvalidated.endLine, unvalidated.startColumn, unvalidated.endColumn, unvalidated.newText].some((value) => value != null)) {
      throw new Error("cannot combine top-level range fields with edits[]");
    }
    rawEdits = unvalidated.edits;
  } else {
    if (unvalidated.startLine == null || unvalidated.newText == null) throw new Error("edit requires startLine and newText, or edits[]");
    rawEdits = [unvalidated];
  }
  if (rawEdits.length === 0) throw new Error("edits must contain at least one range");
  const edits = rawEdits.map((edit) => {
    if (edit.startLine == null || edit.newText == null) throw new Error("each edit requires startLine and newText");
    const startLine = edit.startLine;
    const endLine = edit.endLine ?? edit.startLine;
    validateRange(startLine, endLine);
    const normalized: NormalizedEdit = {
      startLine,
      endLine,
      startColumn: edit.startColumn,
      endColumn: edit.endColumn,
      newText: edit.newText
    };
    validateColumns(normalized);
    return normalized;
  });
  edits.sort((a, b) => a.startLine - b.startLine || (a.startColumn ?? 0) - (b.startColumn ?? 0) || a.endLine - b.endLine || (a.endColumn ?? 0) - (b.endColumn ?? 0));
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1]!;
    const cur = edits[i]!;
    if (prev.startLine === cur.startLine && (prev.startColumn != null || cur.startColumn != null)) {
      if (prev.startColumn == null || cur.startColumn == null) throw new Error("cannot mix full-line and column edits on same line");
      if (cur.startColumn <= prev.endColumn!) throw new Error("edit ranges must not overlap");
      continue;
    }
    if (cur.startLine <= prev.endLine) throw new Error("edit ranges must not overlap");
  }
  return edits;
}

function snapshotMatches(snapshotLines: string[], realLines: string[]): boolean {
  return snapshotLines.length === realLines.length && snapshotLines.every((line, i) => line === realLines[i]);
}

function rangeLabel(edit: NormalizedEdit): string {
  const linePart = edit.startLine === edit.endLine ? `${edit.startLine}` : `${edit.startLine}-${edit.endLine}`;
  if (edit.startColumn == null || edit.endColumn == null) return linePart;
  return `${linePart}:${edit.startColumn}-${edit.endColumn}`;
}

function editAddressSize(edit: NormalizedEdit): number {
  const parts = [String(edit.startLine), String(edit.endLine)];
  if (edit.startColumn != null && edit.endColumn != null) parts.push(String(edit.startColumn), String(edit.endColumn));
  return parts.join("").length;
}

function multiSuccessDelta(parts: Array<{ oldText: string; edit: NormalizedEdit }>): LeanEditDelta {
  const charsNormalEdit = parts.reduce((sum, part) => sum + part.oldText.length + part.edit.newText.length, 0);
  const charsLeanEdit = parts.reduce((sum, part) => sum + editAddressSize(part.edit) + part.edit.newText.length, 0);
  return { attempts: 1, failures: 0, charsSaved: Math.max(0, charsNormalEdit - charsLeanEdit), charsNormalEdit, charsLeanEdit };
}

function lookupCoverage(store: SnapshotStore, full: string, edit: NormalizedEdit): SnapshotCoverage | undefined {
  if (edit.startColumn == null || edit.endColumn == null) {
    const snapshot = store.covered(full, edit.startLine, edit.endLine);
    return snapshot ? { kind: "full-line", lines: snapshot.lines } : undefined;
  }
  const wholeLine = store.covered(full, edit.startLine, edit.startLine);
  if (wholeLine) return { kind: "full-line", lines: wholeLine.lines };
  const columnSnapshot = store.coveredColumns(full, edit.startLine, edit.startColumn, edit.endColumn);
  if (!columnSnapshot?.editEligible) return undefined;
  return { kind: "column", snapshot: columnSnapshot };
}


function coverageMatches(edit: NormalizedEdit, coverage: SnapshotCoverage, realLine: string): boolean {
  if (coverage.kind === "full-line") return snapshotMatches(coverage.lines, [realLine]);
  const expected = sliceColumns(coverage.snapshot.text, edit.startColumn! - coverage.snapshot.startColumn + 1, edit.endColumn! - coverage.snapshot.startColumn + 1);
  const actual = sliceColumns(realLine, edit.startColumn!, edit.endColumn!);
  return expected === actual;
}

function refreshStaleRanges(store: SnapshotStore, path: string, edits: NormalizedEdit[], coverages: Array<SnapshotCoverage | undefined>, parsed: SplitText, config: LeanEditConfig): string | undefined {
  const contextLines = 5;
  const lineRanges: Array<{ startLine: number; endLine: number }> = [];
  for (const edit of edits) {
    if (edit.startColumn != null && edit.endColumn != null) continue;
    const range = {
      startLine: Math.max(1, edit.startLine - contextLines),
      endLine: Math.min(parsed.lines.length, edit.endLine + contextLines)
    };
    const previous = lineRanges.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else lineRanges.push(range);
  }

  const refreshed = new Map<string, { startLine: number; text: string; store: () => void }>();
  for (const range of lineRanges) {
    const lines = sliceRange(parsed.lines, range.startLine, range.endLine);
    refreshed.set(`lines:${range.startLine}-${range.endLine}`, {
      startLine: range.startLine,
      text: formatNumberedLines(lines, range.startLine),
      store: () => store.set({ path, readAt: Date.now(), startLine: range.startLine, endLine: range.endLine, lines, lineEnding: parsed.lineEnding })
    });
  }

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const coverage = coverages[i];
    if (edit.startColumn == null || edit.endColumn == null) continue;

    const line = parsed.lines[edit.startLine - 1]!;
    const coveredByLineRefresh = lineRanges.some((range) => edit.startLine >= range.startLine && edit.startLine <= range.endLine);
    if (coverage?.kind === "full-line") {
      if (coveredByLineRefresh) continue;
      refreshed.set(`line:${edit.startLine}`, {
        startLine: edit.startLine,
        text: formatNumberedLines([line], edit.startLine),
        store: () => store.set({ path, readAt: Date.now(), startLine: edit.startLine, endLine: edit.startLine, lines: [line], lineEnding: parsed.lineEnding })
      });
      continue;
    }

    if (edit.endColumn - edit.startColumn + 1 > (config.maxColumns ?? 400)) return undefined;
    if (coveredByLineRefresh) continue;
    const text = sliceColumns(line, edit.startColumn, edit.endColumn);
    refreshed.set(`columns:${edit.startLine}:${edit.startColumn}-${edit.endColumn}`, {
      startLine: edit.startLine,
      text: formatColumnLine(edit.startLine, edit.startColumn, edit.endColumn, text),
      store: () => store.setColumns({
        path,
        readAt: Date.now(),
        line: edit.startLine,
        startColumn: edit.startColumn!,
        endColumn: edit.endColumn!,
        text,
        lineLength: codePointLength(line),
        lineEnding: parsed.lineEnding,
        editEligible: true
      })
    });
  }

  const entries = [...refreshed.values()].sort((a, b) => a.startLine - b.startLine);
  const text = entries.map((entry) => entry.text).join("\n");
  const outputLines = text ? text.split("\n").length : 0;
  if (outputLines > config.maxLines || Buffer.byteLength(text, "utf8") > config.maxBytes) return undefined;
  for (const entry of entries) entry.store();
  return text;
}

function normalizeColumnReplacement(newText: string, lineEnding: SplitText["lineEnding"]): string {
  return newText.replace(/\r\n|\r|\n/g, lineEnding);
}

function applyColumnEdits(line: string, edits: NormalizedEdit[], lineEnding: SplitText["lineEnding"]): string {
  let result = line;
  for (const edit of [...edits].sort((a, b) => b.startColumn! - a.startColumn!)) {
    result = replaceColumns(result, edit.startColumn!, edit.endColumn!, normalizeColumnReplacement(edit.newText, lineEnding));
  }
  return result;
}

function columnOutputLineCount(edits: NormalizedEdit[], lineEnding: SplitText["lineEnding"]): number {
  return 1 + edits.reduce((count, edit) => count + normalizeColumnReplacement(edit.newText, lineEnding).split(lineEnding).length - 1, 0);
}

function partialColumnSeeds(edits: NormalizedEdit[], finalStartLine: number, lineEnding: SplitText["lineEnding"]): PostEditSeed[] {
  const rows: Array<{ pieces: SymbolicPiece[] }> = [{ pieces: [] }];
  let row = rows[0]!;
  let sourceColumn = 1;

  const appendUnknown = (length?: number): void => {
    if (length === 0) return;
    row.pieces.push({ kind: "unknown", length });
  };
  const appendReplacement = (newText: string): void => {
    const fragments = normalizeColumnReplacement(newText, lineEnding).split(lineEnding);
    for (let i = 0; i < fragments.length; i++) {
      const text = fragments[i]!;
      if (text) row.pieces.push({ kind: "known", text });
      if (i < fragments.length - 1) {
        row = { pieces: [] };
        rows.push(row);
      }
    }
  };

  for (const edit of edits) {
    appendUnknown(edit.startColumn! - sourceColumn);
    appendReplacement(edit.newText);
    sourceColumn = edit.endColumn! + 1;
  }
  // The unread suffix might be empty, but its length was not exposed. Keeping it
  // symbolic prevents an internal filesystem read from promoting the final row.
  appendUnknown();

  const seeds: PostEditSeed[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const pieces = rows[rowIndex]!.pieces;
    const line = finalStartLine + rowIndex;
    if (pieces.every((piece) => piece.kind === "known")) {
      seeds.push({ kind: "full-line", startLine: line, lines: [pieces.map((piece) => piece.kind === "known" ? piece.text : "").join("")] });
      continue;
    }

    let column = 1;
    for (const piece of pieces) {
      if (piece.kind === "unknown") {
        if (piece.length == null) break;
        column += piece.length;
        continue;
      }
      const length = codePointLength(piece.text);
      if (length > 0) seeds.push({ kind: "column", line, startColumn: column, endColumn: column + length - 1, text: piece.text });
      column += length;
    }
  }
  return seeds;
}

function buildPostEditSeeds(edits: NormalizedEdit[], coverages: Array<SnapshotCoverage | undefined>, parsed: SplitText, after: string): PostEditSeed[] {
  const seeds: PostEditSeed[] = [];
  let lineDelta = 0;

  for (let i = 0; i < edits.length;) {
    const edit = edits[i]!;
    const finalStartLine = edit.startLine + lineDelta;
    if (edit.startColumn == null || edit.endColumn == null) {
      const lines = replacementLines(edit.newText);
      if (lines.length > 0) seeds.push({ kind: "full-line", startLine: finalStartLine, lines });
      lineDelta += lines.length - (edit.endLine - edit.startLine + 1);
      i++;
      continue;
    }

    let end = i + 1;
    while (end < edits.length && edits[end]!.startLine === edit.startLine && edits[end]!.startColumn != null) end++;
    const lineEdits = edits.slice(i, end);
    const lineCoverages = coverages.slice(i, end);
    if (lineCoverages.every((coverage) => coverage?.kind === "full-line")) {
      const sourceLine = (lineCoverages[0] as Extract<SnapshotCoverage, { kind: "full-line" }>).lines[0]!;
      const lines = applyColumnEdits(sourceLine, lineEdits, parsed.lineEnding).split(parsed.lineEnding);
      seeds.push({ kind: "full-line", startLine: finalStartLine, lines });
    } else {
      seeds.push(...partialColumnSeeds(lineEdits, finalStartLine, parsed.lineEnding));
    }
    lineDelta += columnOutputLineCount(lineEdits, parsed.lineEnding) - 1;
    i = end;
  }

  const afterLines = splitText(after).lines;
  const validated: PostEditSeed[] = [];
  for (const seed of seeds) {
    if (seed.kind === "full-line") {
      let lines = seed.lines;
      const endLine = seed.startLine + lines.length - 1;
      // A terminal empty logical row is represented only by the file's final
      // newline, so splitText() does not expose it as an addressable row.
      if (endLine === afterLines.length + 1 && lines.at(-1) === "") lines = lines.slice(0, -1);
      if (lines.length === 0) continue;
      const actual = sliceRange(afterLines, seed.startLine, seed.startLine + lines.length - 1);
      if (!snapshotMatches(lines, actual)) throw new Error("internal post-edit snapshot seed mismatch");
      validated.push({ ...seed, lines });
      continue;
    }
    const actualLine = afterLines[seed.line - 1];
    if (actualLine == null || sliceColumns(actualLine, seed.startColumn, seed.endColumn) !== seed.text) {
      throw new Error("internal post-edit snapshot seed mismatch");
    }
    validated.push(seed);
  }
  return validated;
}

function keepsSameLineCount(edit: NormalizedEdit): boolean {
  if (edit.startColumn != null && edit.endColumn != null) return !/[\r\n]/.test(edit.newText);
  return replacementLines(edit.newText).length === (edit.endLine - edit.startLine + 1);
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

function reseedSnapshots(store: SnapshotStore, path: string, seeds: PostEditSeed[], lineEnding: SplitText["lineEnding"]): void {
  const readAt = Date.now();
  for (const seed of seeds) {
    if (seed.kind === "full-line") {
      store.set({ path, readAt, startLine: seed.startLine, endLine: seed.startLine + seed.lines.length - 1, lines: seed.lines, lineEnding });
    } else {
      store.setColumns({ path, readAt, line: seed.line, startColumn: seed.startColumn, endColumn: seed.endColumn, text: seed.text, lineEnding, editEligible: true });
    }
  }
}

export async function leanEdit(
  cwd: string,
  input: LeanEditInput,
  store: SnapshotStore = snapshotStore,
  config: LeanEditConfig = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 }
): Promise<LeanEditResult> {
  const invocationRevision = store.revision();
  const edits = normalizeEdits(input);
  const full = await resolveCanonicalPath(cwd, input.path);
  if (store.revision(full) > invocationRevision) throw new Error("file stale, read again: snapshot changed while edit was starting");
  const initialCoverages = edits.map((edit) => lookupCoverage(store, full, edit));
  const initialRevision = store.revision(full);

  return withInterprocessFileMutationLock(full, () => withFileMutationQueue(full, async () => {
    if (store.revision(full) !== initialRevision) throw new Error("file stale, read again: snapshot changed while edit was queued");
    const before = await fs.readFile(full, "utf8");
    const parsed = splitText(before);
    const parts: Array<{ oldText: string; edit: NormalizedEdit }> = [];
    let missingCoverage = false;
    let changedCoverage = false;

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      if (edit.endLine > parsed.lines.length) throw new Error("file stale, read again: requested range is beyond end of file");
      const coverage = initialCoverages[i];

      if (edit.startColumn != null && edit.endColumn != null) {
        const line = parsed.lines[edit.startLine - 1]!;
        if (edit.endColumn > codePointLength(line)) throw new Error("file stale, read again: requested columns are beyond end of line");
        if (!coverage) missingCoverage = true;
        else if (!coverageMatches(edit, coverage, line)) changedCoverage = true;
        parts.push({ oldText: sliceColumns(line, edit.startColumn, edit.endColumn), edit });
      } else {
        const actual = sliceRange(parsed.lines, edit.startLine, edit.endLine);
        if (!coverage) missingCoverage = true;
        else if (coverage.kind !== "full-line" || !snapshotMatches(coverage.lines, actual)) changedCoverage = true;
        parts.push({ oldText: rangeText(parsed.lines, edit.startLine, edit.endLine, parsed.lineEnding), edit });
      }
    }

    if (missingCoverage || changedCoverage) {
      const refreshedText = refreshStaleRanges(store, full, edits, initialCoverages, parsed, config);
      if (refreshedText == null) throw new Error("file stale, read again: updated range exceeds automatic refresh limits");
      const reason = missingCoverage && changedCoverage
        ? "one or more requested ranges were not read beforehand, and other requested text changed since it was read"
        : missingCoverage
          ? "one or more requested ranges were not read beforehand"
          : "the requested text changed since it was read";
      throw new StaleEditError(refreshedText, reason);
    }

    const nextLines = [...parsed.lines];
    const columnEditsByLine = new Map<number, NormalizedEdit[]>();
    for (const edit of edits) {
      if (edit.startColumn != null && edit.endColumn != null) {
        const list = columnEditsByLine.get(edit.startLine) ?? [];
        list.push(edit);
        columnEditsByLine.set(edit.startLine, list);
      }
    }

    for (const [lineNumber, lineEdits] of columnEditsByLine) {
      nextLines[lineNumber - 1] = applyColumnEdits(nextLines[lineNumber - 1]!, lineEdits, parsed.lineEnding);
    }

    for (const edit of [...edits].reverse()) {
      if (edit.startColumn != null && edit.endColumn != null) continue;
      nextLines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines(edit.newText));
    }

    const hasFinalEmptyReplacementRow = edits.some((edit) =>
      edit.startColumn == null && edit.endLine === parsed.lines.length && replacementLines(edit.newText).at(-1) === ""
    );
    const after = joinText(nextLines, parsed.lineEnding, parsed.finalNewline || hasFinalEmptyReplacementRow);
    const seeds = buildPostEditSeeds(edits, initialCoverages, parsed, after);
    await fs.writeFile(full, after, "utf8");
    invalidateSnapshotsAfterEdit(store, full, edits);
    reseedSnapshots(store, full, seeds, parsed.lineEnding);

    const diff = unifiedDiff(input.path, before, after);
    const delta = multiSuccessDelta(parts);
    const labels = edits.map(rangeLabel).join(",");
    return {
      text: `Applied edit to ${input.path}:${labels}`,
      diff,
      firstChangedLine: firstChangedLine(before, after),
      delta
    };
  }));
}
