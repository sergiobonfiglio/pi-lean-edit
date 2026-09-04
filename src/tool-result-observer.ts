import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isBashToolResult,
  isEditToolResult,
  isGrepToolResult,
  isWriteToolResult,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import type { SnapshotStore } from "./snapshot-store.ts";

type OutputMarker = {
  displayPath: string;
  line: number;
  text: string;
};

type PathMetadata = {
  path: string;
  isDirectory: boolean;
  isFile: boolean;
};

type ResolvedRow = {
  path: string;
  line: number;
  text: string;
};

function markerCandidates(row: string): OutputMarker[] {
  const candidates: OutputMarker[] = [];
  for (const expression of [/:(\d+):/g, /-(\d+)-/g]) {
    for (const match of row.matchAll(expression)) {
      const line = Number(match[1]);
      const displayPath = row.slice(0, match.index);
      if (!displayPath || !Number.isSafeInteger(line) || line < 1) continue;
      candidates.push({ displayPath, line, text: row.slice(match.index + match[0].length) });
    }
  }
  return candidates;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function textContent(event: ToolResultEvent): string {
  return event.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function grepOutput(event: ToolResultEvent): string {
  const text = textContent(event);
  const footerStart = text.indexOf("\n\n[");
  return footerStart === -1 ? text : text.slice(0, footerStart);
}

function createMetadataResolver() {
  const cache = new Map<string, Promise<PathMetadata | undefined>>();
  return (base: string, displayPath: string): Promise<PathMetadata | undefined> => {
    const resolved = path.isAbsolute(displayPath) ? path.normalize(displayPath) : path.resolve(base, displayPath);
    let pending = cache.get(resolved);
    if (!pending) {
      pending = (async () => {
        try {
          const canonical = await fs.realpath(resolved);
          const stat = await fs.stat(canonical);
          return { path: canonical, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
        } catch {
          return undefined;
        }
      })();
      cache.set(resolved, pending);
    }
    return pending;
  };
}

async function stageRows(
  rows: string[],
  resolveMarker: (marker: OutputMarker) => Promise<ResolvedRow | undefined>,
  signal?: AbortSignal
): Promise<ResolvedRow[]> {
  const staged: ResolvedRow[] = [];
  for (const row of rows) {
    const matches = new Map<string, ResolvedRow>();
    for (const marker of markerCandidates(row)) {
      const resolved = await resolveMarker(marker);
      signal?.throwIfAborted();
      if (!resolved) continue;
      matches.set(`${resolved.path}\0${resolved.line}\0${resolved.text}`, resolved);
    }
    if (matches.size === 1) staged.push([...matches.values()][0]!);
  }
  return staged;
}

function commitRows(store: SnapshotStore, revision: number, rows: ResolvedRow[]): void {
  if (store.revision() !== revision) return;
  for (const row of rows) {
    store.set({ path: row.path, startLine: row.line, endLine: row.line, lines: [row.text] });
  }
}

async function observeGrep(event: ToolResultEvent, cwd: string, store: SnapshotStore, signal?: AbortSignal): Promise<void> {
  if (!isGrepToolResult(event) || event.isError) return;
  if (event.content.some((item) => item.type === "image")) return;

  const rows = grepOutput(event).split("\n").filter((row) => row.length > 0);
  if (rows.length === 0 || rows[0] === "No matches found") return;
  const invocationRevision = store.revision();
  const metadata = createMetadataResolver();
  const rawSearchPath = typeof event.input.path === "string" && event.input.path ? event.input.path : ".";
  const search = await metadata(cwd, rawSearchPath);
  signal?.throwIfAborted();
  if (!search || (!search.isDirectory && !search.isFile)) return;

  const staged = await stageRows(rows, async (marker) => {
    // Pi's built-in grep inserts one formatting space after its marker.
    if (!marker.text.startsWith(" ")) return undefined;
    const text = marker.text.slice(1);
    if (event.details?.linesTruncated && text.endsWith("... [truncated]")) return undefined;

    if (search.isFile) {
      if (marker.displayPath !== path.basename(search.path)) return undefined;
      return { path: search.path, line: marker.line, text };
    }

    const lexicalPath = path.resolve(search.path, marker.displayPath);
    if (!isWithin(search.path, lexicalPath)) return undefined;
    const candidate = await metadata(search.path, marker.displayPath);
    if (!candidate?.isFile || !isWithin(search.path, candidate.path)) return undefined;
    return { path: candidate.path, line: marker.line, text };
  }, signal);

  signal?.throwIfAborted();
  commitRows(store, invocationRevision, staged);
}

async function observeBash(event: ToolResultEvent, cwd: string, store: SnapshotStore, signal?: AbortSignal): Promise<void> {
  if (!isBashToolResult(event) || event.isError) return;
  const truncation = event.details?.truncation;
  const output = truncation?.truncated ? truncation.content : textContent(event);
  const rows = output.split("\n");
  if (truncation?.lastLinePartial) rows.shift();
  const invocationRevision = store.revision();
  const metadata = createMetadataResolver();

  const staged = await stageRows(rows, async (marker) => {
    const candidate = await metadata(cwd, marker.displayPath);
    if (!candidate?.isFile) return undefined;
    return { path: candidate.path, line: marker.line, text: marker.text };
  }, signal);

  signal?.throwIfAborted();
  commitRows(store, invocationRevision, staged);
}

export async function observeToolResult(event: ToolResultEvent, cwd: string, store: SnapshotStore, signal?: AbortSignal): Promise<void> {
  if (event.isError) return;

  if (isEditToolResult(event) || isWriteToolResult(event)) {
    const rawPath = typeof event.input.path === "string" ? event.input.path : undefined;
    if (!rawPath) return;
    const metadata = createMetadataResolver();
    const target = await metadata(cwd, rawPath);
    store.clear(target?.path ?? (path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(cwd, rawPath)));
    return;
  }

  if (isBashToolResult(event)) await observeBash(event, cwd, store, signal);
  else await observeGrep(event, cwd, store, signal);
}

export const toolResultObserverInternals = { markerCandidates };
