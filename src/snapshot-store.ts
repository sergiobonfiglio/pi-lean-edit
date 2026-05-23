import type { LineEnding } from "./line-utils.ts";

export type FileSnapshot = {
  path: string;
  readAt: number;
  startLine: number;
  endLine: number;
  lines: string[];
  lineEnding: LineEnding;
};

type SnapshotSegment = Omit<FileSnapshot, "path">;

type FileMemory = {
  path: string;
  segments: SnapshotSegment[];
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

export class SnapshotStore {
  private files = new Map<string, FileMemory>();

  set(snapshot: FileSnapshot): void {
    const memory = this.files.get(snapshot.path) ?? { path: snapshot.path, segments: [] };
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

  delete(path: string): void {
    this.files.delete(path);
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
    if (next.length === 0) this.files.delete(path);
    else memory.segments = mergeAdjacent(next);
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
}

export const snapshotStore = new SnapshotStore();
