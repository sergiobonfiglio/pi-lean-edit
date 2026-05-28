import type { LineEnding } from "./line-utils.ts";
import { sliceColumns } from "./line-utils.ts";

export type FileSnapshot = {
  path: string;
  readAt: number;
  startLine: number;
  endLine: number;
  lines: string[];
  lineEnding: LineEnding;
};

export type ColumnSnapshot = {
  path: string;
  readAt: number;
  line: number;
  startColumn: number;
  endColumn: number;
  text: string;
  lineLength?: number;
  lineEnding: LineEnding;
  hugeLine: boolean;
};

type SnapshotSegment = Omit<FileSnapshot, "path">;
type ColumnSnapshotSegment = Omit<ColumnSnapshot, "path">;

type FileMemory = {
  path: string;
  segments: SnapshotSegment[];
  columnSegments: ColumnSnapshotSegment[];
};

function cloneSnapshot(snapshot: FileSnapshot): FileSnapshot {
  return { ...snapshot, lines: [...snapshot.lines] };
}

function cloneSegment(segment: SnapshotSegment): SnapshotSegment {
  return { ...segment, lines: [...segment.lines] };
}

function segmentSlice(segment: SnapshotSegment, startLine: number, endLine: number): SnapshotSegment {
  const offset = startLine - segment.startLine;
  return {
    ...segment,
    startLine,
    endLine,
    lines: segment.lines.slice(offset, offset + (endLine - startLine + 1))
  };
}

function mergeAdjacent(segments: SnapshotSegment[]): SnapshotSegment[] {
  const sorted = [...segments].sort((a, b) => a.startLine - b.startLine || a.readAt - b.readAt);
  const merged: SnapshotSegment[] = [];
  for (const segment of sorted) {
    const prev = merged.at(-1);
    if (prev && prev.endLine + 1 === segment.startLine && prev.lineEnding === segment.lineEnding) {
      prev.endLine = segment.endLine;
      prev.readAt = Math.max(prev.readAt, segment.readAt);
      prev.lines.push(...segment.lines);
    } else {
      merged.push(cloneSegment(segment));
    }
  }
  return merged;
}

function cloneColumnSegment(segment: ColumnSnapshotSegment): ColumnSnapshotSegment {
  return { ...segment };
}

function segmentCoversColumns(segment: ColumnSnapshotSegment, startColumn: number, endColumn: number): boolean {
  return segment.startColumn <= startColumn && segment.endColumn >= endColumn;
}

function columnSegmentSlice(segment: ColumnSnapshotSegment, startColumn: number, endColumn: number): ColumnSnapshotSegment {
  return {
    ...segment,
    startColumn,
    endColumn,
    text: sliceColumns(segment.text, startColumn - segment.startColumn + 1, endColumn - segment.startColumn + 1)
  };
}

function canMergeColumnSegments(a: ColumnSnapshotSegment, b: ColumnSnapshotSegment): boolean {
  return a.line === b.line &&
    a.lineEnding === b.lineEnding &&
    a.hugeLine === b.hugeLine &&
    a.lineLength === b.lineLength &&
    b.startColumn <= a.endColumn + 1;
}

function mergeAdjacentColumns(segments: ColumnSnapshotSegment[]): ColumnSnapshotSegment[] {
  const sorted = [...segments].sort((a, b) => a.line - b.line || a.startColumn - b.startColumn || a.readAt - b.readAt);
  const merged: ColumnSnapshotSegment[] = [];
  for (const segment of sorted) {
    const prev = merged.at(-1);
    if (!prev || !canMergeColumnSegments(prev, segment)) {
      merged.push(cloneColumnSegment(segment));
      continue;
    }
    if (segment.endColumn <= prev.endColumn) {
      prev.readAt = Math.max(prev.readAt, segment.readAt);
      continue;
    }
    const tailStart = Math.max(prev.endColumn + 1, segment.startColumn);
    prev.text += sliceColumns(segment.text, tailStart - segment.startColumn + 1, segment.endColumn - segment.startColumn + 1);
    prev.endColumn = segment.endColumn;
    prev.readAt = Math.max(prev.readAt, segment.readAt);
  }
  return merged;
}

export class SnapshotStore {
  private files = new Map<string, FileMemory>();

  set(snapshot: FileSnapshot): void {
    const memory = this.files.get(snapshot.path) ?? { path: snapshot.path, segments: [], columnSegments: [] };
    const next: SnapshotSegment[] = [];
    for (const segment of memory.segments) {
      if (segment.endLine < snapshot.startLine || segment.startLine > snapshot.endLine) {
        next.push(cloneSegment(segment));
        continue;
      }
      if (segment.startLine < snapshot.startLine) next.push(segmentSlice(segment, segment.startLine, snapshot.startLine - 1));
      if (segment.endLine > snapshot.endLine) next.push(segmentSlice(segment, snapshot.endLine + 1, segment.endLine));
    }
    next.push({ readAt: snapshot.readAt, startLine: snapshot.startLine, endLine: snapshot.endLine, lines: [...snapshot.lines], lineEnding: snapshot.lineEnding });
    memory.segments = mergeAdjacent(next);
    this.files.set(snapshot.path, memory);
  }

  setColumns(snapshot: ColumnSnapshot): void {
    const memory = this.files.get(snapshot.path) ?? { path: snapshot.path, segments: [], columnSegments: [] };
    const next: ColumnSnapshotSegment[] = [];
    for (const segment of memory.columnSegments) {
      if (segment.line !== snapshot.line || segment.endColumn < snapshot.startColumn || segment.startColumn > snapshot.endColumn) {
        next.push(cloneColumnSegment(segment));
        continue;
      }
      if (segment.startColumn < snapshot.startColumn) next.push(columnSegmentSlice(segment, segment.startColumn, snapshot.startColumn - 1));
      if (segment.endColumn > snapshot.endColumn) next.push(columnSegmentSlice(segment, snapshot.endColumn + 1, segment.endColumn));
    }
    next.push({
      readAt: snapshot.readAt,
      line: snapshot.line,
      startColumn: snapshot.startColumn,
      endColumn: snapshot.endColumn,
      text: snapshot.text,
      lineLength: snapshot.lineLength,
      lineEnding: snapshot.lineEnding,
      hugeLine: snapshot.hugeLine
    });
    memory.columnSegments = mergeAdjacentColumns(next);
    this.files.set(snapshot.path, memory);
  }

  get(path: string): FileSnapshot | undefined {
    const memory = this.files.get(path);
    if (!memory || memory.segments.length === 0) return undefined;
    const segments = memory.segments;
    return cloneSnapshot({
      path,
      readAt: Math.max(...segments.map((s) => s.readAt)),
      startLine: Math.min(...segments.map((s) => s.startLine)),
      endLine: Math.max(...segments.map((s) => s.endLine)),
      lines: [],
      lineEnding: segments[0]!.lineEnding
    });
  }

  ranges(path: string): Array<{ startLine: number; endLine: number }> {
    return (this.files.get(path)?.segments ?? []).map((segment) => ({ startLine: segment.startLine, endLine: segment.endLine }));
  }

  columnRanges(path: string): Array<{ line: number; startColumn: number; endColumn: number }> {
    return (this.files.get(path)?.columnSegments ?? []).map((segment) => ({ line: segment.line, startColumn: segment.startColumn, endColumn: segment.endColumn }));
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  invalidateRanges(path: string, ranges: Array<{ startLine: number; endLine: number }>): void {
    const memory = this.files.get(path);
    if (!memory || ranges.length === 0) return;
    const next: SnapshotSegment[] = [];
    for (const segment of memory.segments) {
      let remaining: SnapshotSegment[] = [cloneSegment(segment)];
      for (const range of ranges) {
        const updated: SnapshotSegment[] = [];
        for (const part of remaining) {
          if (part.endLine < range.startLine || part.startLine > range.endLine) {
            updated.push(part);
            continue;
          }
          if (part.startLine < range.startLine) updated.push(segmentSlice(part, part.startLine, range.startLine - 1));
          if (part.endLine > range.endLine) updated.push(segmentSlice(part, range.endLine + 1, part.endLine));
        }
        remaining = updated;
        if (remaining.length === 0) break;
      }
      next.push(...remaining);
    }
    const nextColumns = memory.columnSegments
      .filter((segment) => !ranges.some((range) => segment.line >= range.startLine && segment.line <= range.endLine))
      .map(cloneColumnSegment);
    if (next.length === 0 && nextColumns.length === 0) this.files.delete(path);
    else {
      memory.segments = mergeAdjacent(next);
      memory.columnSegments = nextColumns;
    }
  }

  truncateAfter(path: string, lastLineToKeep: number): void {
    const memory = this.files.get(path);
    if (!memory) return;
    const next: SnapshotSegment[] = [];
    for (const segment of memory.segments) {
      if (segment.startLine > lastLineToKeep) continue;
      if (segment.endLine <= lastLineToKeep) next.push(cloneSegment(segment));
      else next.push(segmentSlice(segment, segment.startLine, lastLineToKeep));
    }
    const nextColumns = memory.columnSegments.filter((segment) => segment.line <= lastLineToKeep).map(cloneColumnSegment);
    if (next.length === 0 && nextColumns.length === 0) this.files.delete(path);
    else {
      memory.segments = mergeAdjacent(next);
      memory.columnSegments = nextColumns;
    }
  }

  clear(): void {
    this.files.clear();
  }

  covered(path: string, startLine: number, endLine: number): FileSnapshot | undefined {
    const memory = this.files.get(path);
    if (!memory) return undefined;
    const lines: string[] = [];
    let cursor = startLine;
    let lineEnding: LineEnding | undefined;
    let readAt = 0;
    for (const segment of memory.segments) {
      if (segment.endLine < cursor) continue;
      if (segment.startLine > cursor) break;
      const takeEnd = Math.min(segment.endLine, endLine);
      const offset = cursor - segment.startLine;
      lines.push(...segment.lines.slice(offset, offset + (takeEnd - cursor + 1)));
      lineEnding ??= segment.lineEnding;
      readAt = Math.max(readAt, segment.readAt);
      cursor = takeEnd + 1;
      if (cursor > endLine) break;
    }
    if (cursor <= endLine || !lineEnding) return undefined;
    return { path, readAt, startLine, endLine, lines, lineEnding };
  }

  coveredColumns(path: string, line: number, startColumn: number, endColumn: number): ColumnSnapshot | undefined {
    const memory = this.files.get(path);
    if (!memory) return undefined;
    let best: ColumnSnapshotSegment | undefined;
    for (const segment of memory.columnSegments) {
      if (segment.line !== line) continue;
      if (!segmentCoversColumns(segment, startColumn, endColumn)) continue;
      if (!best || segment.startColumn > best.startColumn || (segment.startColumn === best.startColumn && segment.endColumn < best.endColumn) || (segment.startColumn === best.startColumn && segment.endColumn === best.endColumn && segment.readAt > best.readAt)) {
        best = segment;
      }
    }
    if (!best) return undefined;
    return { path, ...best };
  }
}

export const snapshotStore = new SnapshotStore();
