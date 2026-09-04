import { createPatch } from "diff";
import { codePointLength, sliceColumns, splitText } from "./line-utils.ts";

export function unifiedDiff(filePath: string, oldText: string, newText: string): string {
  return createPatch(filePath, oldText, newText, "before", "after", { context: 3 });
}

function lineExcerpt(line: string, startColumn: number, endColumn: number): string {
  const contextColumns = 80;
  const length = codePointLength(line);
  const start = Math.max(1, startColumn - contextColumns);
  const end = Math.min(length, Math.max(startColumn - 1, endColumn) + contextColumns);
  const text = length === 0 ? "" : sliceColumns(line, start, end);
  return `${start > 1 ? "…" : ""}${text}${end < length ? "…" : ""}`;
}

export function boundedLineDiff(filePath: string, lineNumber: number, oldLine: string, newLine: string, startColumn: number, oldEndColumn: number, replacementLength: number): string {
  if (oldLine === newLine) return "";
  const newEndColumn = startColumn + replacementLength - 1;
  const oldExcerpt = lineExcerpt(oldLine, startColumn, oldEndColumn);
  const newExcerpt = lineExcerpt(newLine, startColumn, newEndColumn);
  return [
    `Index: ${filePath}`,
    "===================================================================",
    `--- ${filePath}\tbefore`,
    `+++ ${filePath}\tafter`,
    `@@ -${lineNumber},1 +${lineNumber},1 @@`,
    `-${oldExcerpt}`,
    `+${newExcerpt}`,
    ""
  ].join("\n");
}

export function firstChangedLine(oldText: string, newText: string): number | undefined {
  const oldLines = splitText(oldText).lines;
  const newLines = splitText(newText).lines;
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) return i + 1;
  }
  return undefined;
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
