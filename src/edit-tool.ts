import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { firstChangedLine, unifiedDiff } from "./diff.ts";
import { joinText, rangeText, replacementLines, resolveCanonicalPath, sliceRange, splitText } from "./line-utils.ts";
import { type SnapshotStore, snapshotStore } from "./snapshot-store.ts";
import { type SmartEditDelta, type SmartEditMetricsSnapshot } from "./metrics.ts";

const smartEditRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 1, description: "First line to replace (1-based, inclusive)" }),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to replace (1-based, inclusive). Defaults to startLine" })),
  newText: Type.String({ description: "Replacement text. Empty string deletes range." })
});

export const smartEditSchema = Type.Object({
  path: Type.String({ description: "Path to edit, relative to cwd unless absolute" }),
  startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First line to replace (1-based, inclusive)" })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to replace (1-based, inclusive). Defaults to startLine" })),
  newText: Type.Optional(Type.String({ description: "Replacement text. Empty string deletes range." })),
  edits: Type.Optional(Type.Array(smartEditRangeSchema, { minItems: 1, description: "One or more non-overlapping line-range edits for this file." }))
});
export type SmartEditInput = Static<typeof smartEditSchema>;

type NormalizedEdit = {
  startLine: number;
  endLine: number;
  newText: string;
};

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

function normalizeEdits(input: SmartEditInput): NormalizedEdit[] {
  const rawEdits = Array.isArray(input.edits) ? input.edits : (() => {
    if (input.startLine == null || input.newText == null) throw new Error("edit requires startLine and newText, or edits[]");
    return [{ startLine: input.startLine, endLine: input.endLine, newText: input.newText }];
  })();
  if (rawEdits.length === 0) throw new Error("edits must contain at least one range");
  const edits = rawEdits.map((edit) => {
    const startLine = edit.startLine;
    const endLine = edit.endLine ?? edit.startLine;
    validateRange(startLine, endLine);
    return { startLine, endLine, newText: edit.newText };
  });
  edits.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i]!.startLine <= edits[i - 1]!.endLine) throw new Error("edit ranges must not overlap");
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
  return edit.startLine === edit.endLine ? `${edit.startLine}` : `${edit.startLine}-${edit.endLine}`;
}

function multiSuccessDelta(parts: Array<{ oldText: string; edit: NormalizedEdit }>): SmartEditDelta {
  const charsNormalEdit = parts.reduce((sum, part) => sum + part.oldText.length + part.edit.newText.length, 0);
  const charsSmartEdit = parts.reduce((sum, part) => sum + String(part.edit.startLine).length + String(part.edit.endLine).length + part.edit.newText.length, 0);
  return { attempts: 1, failures: 0, charsSaved: Math.max(0, charsNormalEdit - charsSmartEdit), charsNormalEdit, charsSmartEdit };
}

export async function smartEdit(cwd: string, input: SmartEditInput, store: SnapshotStore = snapshotStore): Promise<SmartEditResult> {
  const edits = normalizeEdits(input);
  const full = await resolveCanonicalPath(cwd, input.path);
  for (const edit of edits) {
    const snapshot = store.covered(full, edit.startLine, edit.endLine);
    if (!snapshot) {
      const ranges = store.ranges(full);
      if (ranges.length === 0) throw new Error("file stale, read again: no snapshot for file");
      const rangeText = ranges.map((range) => `${range.startLine}-${range.endLine}`).join(", ");
      throw new Error(`file stale, read again: known ranges ${rangeText}`);
    }
  }

  return withFileMutationQueue(full, async () => {
    const before = await fs.readFile(full, "utf8");
    const parsed = splitText(before);
    const parts: Array<{ oldText: string; edit: NormalizedEdit }> = [];

    for (const edit of edits) {
      if (edit.endLine > parsed.lines.length) throw new Error("file stale, read again");
      const snapshot = store.covered(full, edit.startLine, edit.endLine);
      if (!snapshot) throw new Error("file stale, read again");
      const snapshotOffset = edit.startLine - snapshot.startLine;
      const expected = snapshot.lines.slice(snapshotOffset, snapshotOffset + (edit.endLine - edit.startLine + 1));
      const actual = sliceRange(parsed.lines, edit.startLine, edit.endLine);
      assertSnapshotMatches(expected, actual);
      parts.push({ oldText: rangeText(parsed.lines, edit.startLine, edit.endLine, parsed.lineEnding), edit });
    }

    const nextLines = [...parsed.lines];
    for (const edit of [...edits].reverse()) {
      nextLines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines(edit.newText));
    }
    const after = joinText(nextLines, parsed.lineEnding, parsed.finalNewline);

    await fs.writeFile(full, after, "utf8");
    store.truncateAfter(full, edits[0]!.startLine - 1);

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
