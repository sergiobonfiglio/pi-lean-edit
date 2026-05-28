import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { firstChangedLine, unifiedDiff } from "./diff.ts";
import { codePointLength, joinText, rangeText, replaceColumns, replacementLines, resolveCanonicalPath, sliceColumns, sliceRange, splitText } from "./line-utils.ts";
import { type ColumnSnapshot, type SnapshotStore, snapshotStore } from "./snapshot-store.ts";
import { type SmartEditDelta, type SmartEditMetricsSnapshot } from "./metrics.ts";

const smartEditRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 1, description: "First line to replace (1-based, inclusive)" }),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to replace (1-based, inclusive). Defaults to startLine" })),
  startColumn: Type.Optional(Type.Integer({ minimum: 1, description: "First column to replace (1-based, inclusive). Single-line only." })),
  endColumn: Type.Optional(Type.Integer({ minimum: 1, description: "Last column to replace (1-based, inclusive). Required with startColumn." })),
  newText: Type.String({ description: "Replacement text. Empty string deletes range." })
});

export const smartEditSchema = Type.Object({
  path: Type.String({ description: "Path to edit, relative to cwd unless absolute" }),
  startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First line to replace (1-based, inclusive)" })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to replace (1-based, inclusive). Defaults to startLine" })),
  startColumn: Type.Optional(Type.Integer({ minimum: 1, description: "First column to replace (1-based, inclusive). Single-line only." })),
  endColumn: Type.Optional(Type.Integer({ minimum: 1, description: "Last column to replace (1-based, inclusive). Required with startColumn." })),
  newText: Type.Optional(Type.String({ description: "Replacement text. Empty string deletes range." })),
  edits: Type.Optional(Type.Array(smartEditRangeSchema, { minItems: 1, description: "One or more non-overlapping edits for this file." }))
});
export type SmartEditInput = Static<typeof smartEditSchema>;

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

export type SmartEditResult = {
  text: string;
  diff: string;
  firstChangedLine?: number;
  delta: SmartEditDelta;
  metrics?: SmartEditMetricsSnapshot;
};

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
  if (edit.newText.includes("\n") || edit.newText.includes("\r")) throw new Error("column edits require single-line newText");
}

function normalizeEdits(input: SmartEditInput): NormalizedEdit[] {
  const rawEdits = Array.isArray(input.edits) ? input.edits : (() => {
    if (input.startLine == null || input.newText == null) throw new Error("edit requires startLine and newText, or edits[]");
    return [{ startLine: input.startLine, endLine: input.endLine, startColumn: input.startColumn, endColumn: input.endColumn, newText: input.newText }];
  })();
  if (rawEdits.length === 0) throw new Error("edits must contain at least one range");
  const edits = rawEdits.map((edit) => {
    const startLine = edit.startLine;
    const endLine = edit.endLine ?? edit.startLine;
    validateRange(startLine, endLine);
    const normalized: NormalizedEdit = { startLine, endLine, startColumn: edit.startColumn, endColumn: edit.endColumn, newText: edit.newText };
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

function assertSnapshotMatches(snapshotLines: string[], realLines: string[]): void {
  if (snapshotLines.length !== realLines.length) throw new Error("file stale, read again");
  for (let i = 0; i < snapshotLines.length; i++) {
    if (snapshotLines[i] !== realLines[i]) throw new Error("file stale, read again");
  }
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

function multiSuccessDelta(parts: Array<{ oldText: string; edit: NormalizedEdit }>): SmartEditDelta {
  const charsNormalEdit = parts.reduce((sum, part) => sum + part.oldText.length + part.edit.newText.length, 0);
  const charsSmartEdit = parts.reduce((sum, part) => sum + editAddressSize(part.edit) + part.edit.newText.length, 0);
  return { attempts: 1, failures: 0, charsSaved: Math.max(0, charsNormalEdit - charsSmartEdit), charsNormalEdit, charsSmartEdit };
}

function lookupCoverage(store: SnapshotStore, full: string, edit: NormalizedEdit): SnapshotCoverage | undefined {
  if (edit.startColumn == null || edit.endColumn == null) {
    const snapshot = store.covered(full, edit.startLine, edit.endLine);
    return snapshot ? { kind: "full-line", lines: snapshot.lines } : undefined;
  }
  const wholeLine = store.covered(full, edit.startLine, edit.startLine);
  if (wholeLine) return { kind: "full-line", lines: wholeLine.lines };
  const columnSnapshot = store.coveredColumns(full, edit.startLine, edit.startColumn, edit.endColumn);
  if (!columnSnapshot || !columnSnapshot.hugeLine) return undefined;
  return { kind: "column", snapshot: columnSnapshot };
}

function staleMessage(store: SnapshotStore, full: string): string {
  const ranges = store.ranges(full).map((range) => `${range.startLine}-${range.endLine}`);
  const columns = store.columnRanges(full).map((range) => `${range.line}:${range.startColumn}-${range.endColumn}`);
  const known = [...ranges, ...columns];
  if (known.length === 0) return "file stale, read again: no snapshot for file";
  return `file stale, read again: known ranges ${known.join(", ")}`;
}

function verifyCoverage(edit: NormalizedEdit, coverage: SnapshotCoverage, realLine: string): void {
  if (coverage.kind === "full-line") {
    assertSnapshotMatches(coverage.lines, [realLine]);
    return;
  }
  const expected = sliceColumns(coverage.snapshot.text, edit.startColumn! - coverage.snapshot.startColumn + 1, edit.endColumn! - coverage.snapshot.startColumn + 1);
  const actual = sliceColumns(realLine, edit.startColumn!, edit.endColumn!);
  if (expected !== actual) throw new Error("file stale, read again");
}

function keepsSameLineCount(edit: NormalizedEdit): boolean {
  if (edit.startColumn != null && edit.endColumn != null) return true;
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

export async function smartEdit(cwd: string, input: SmartEditInput, store: SnapshotStore = snapshotStore): Promise<SmartEditResult> {
  const edits = normalizeEdits(input);
  const full = await resolveCanonicalPath(cwd, input.path);
  for (const edit of edits) {
    if (!lookupCoverage(store, full, edit)) throw new Error(staleMessage(store, full));
  }

  return withFileMutationQueue(full, async () => {
    const before = await fs.readFile(full, "utf8");
    const parsed = splitText(before);
    const parts: Array<{ oldText: string; edit: NormalizedEdit }> = [];

    for (const edit of edits) {
      if (edit.endLine > parsed.lines.length) throw new Error("file stale, read again");
      if (edit.startColumn != null && edit.endColumn != null) {
        const line = parsed.lines[edit.startLine - 1]!;
        if (edit.endColumn > codePointLength(line)) throw new Error("file stale, read again");
        const coverage = lookupCoverage(store, full, edit);
        if (!coverage) throw new Error("file stale, read again");
        verifyCoverage(edit, coverage, line);
        parts.push({ oldText: sliceColumns(line, edit.startColumn, edit.endColumn), edit });
      } else {
        const snapshot = store.covered(full, edit.startLine, edit.endLine);
        if (!snapshot) throw new Error("file stale, read again");
        const snapshotOffset = edit.startLine - snapshot.startLine;
        const expected = snapshot.lines.slice(snapshotOffset, snapshotOffset + (edit.endLine - edit.startLine + 1));
        const actual = sliceRange(parsed.lines, edit.startLine, edit.endLine);
        assertSnapshotMatches(expected, actual);
        parts.push({ oldText: rangeText(parsed.lines, edit.startLine, edit.endLine, parsed.lineEnding), edit });
      }
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
      lineEdits.sort((a, b) => b.startColumn! - a.startColumn!);
      let line = nextLines[lineNumber - 1]!;
      for (const edit of lineEdits) line = replaceColumns(line, edit.startColumn!, edit.endColumn!, edit.newText);
      nextLines[lineNumber - 1] = line;
    }

    for (const edit of [...edits].reverse()) {
      if (edit.startColumn != null && edit.endColumn != null) continue;
      nextLines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines(edit.newText));
    }

    const after = joinText(nextLines, parsed.lineEnding, parsed.finalNewline);
    await fs.writeFile(full, after, "utf8");
    invalidateSnapshotsAfterEdit(store, full, edits);

    const diff = unifiedDiff(input.path, before, after);
    const delta = multiSuccessDelta(parts);
    const labels = edits.map(rangeLabel).join(",");
    return {
      text: `Applied edit to ${input.path}:${labels}`,
      diff,
      firstChangedLine: firstChangedLine(before, after),
      delta
    };
  });
}
