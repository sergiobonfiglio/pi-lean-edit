import { createPatch } from "diff";
import { splitText } from "./line-utils.ts";

export function unifiedDiff(filePath: string, oldText: string, newText: string): string {
  return createPatch(filePath, oldText, newText, "before", "after", { context: 3 });
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
