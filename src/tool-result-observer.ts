import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isEditToolResult,
  isGrepToolResult,
  isWriteToolResult,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { decodeUtf8, fingerprintBytes, isBinary, resolveCanonicalPath, splitText } from "./line-utils.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

type ParsedFile = {
  fingerprint: string;
  lines: string[];
};

type GrepMarker = {
  displayPath: string;
  line: number;
  text: string;
};

function markerCandidates(row: string): GrepMarker[] {
  const candidates: GrepMarker[] = [];
  for (const expression of [/:(\d+): /g, /-(\d+)- /g]) {
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

async function readTextFile(filePath: string, signal?: AbortSignal): Promise<ParsedFile | undefined> {
  try {
    const buffer = await fs.readFile(filePath, { signal });
    if (isBinary(buffer)) return undefined;
    return { fingerprint: fingerprintBytes(buffer), lines: splitText(decodeUtf8(buffer)).lines };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).name === "AbortError") throw error;
    return undefined;
  }
}

function setLineSnapshots(store: SnapshotStore, filePath: string, parsed: ParsedFile, lineNumbers: number[]): void {
  store.observeFile(filePath, parsed.fingerprint);
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return;
  let start = sorted[0]!;
  let end = start;

  const flush = () => {
    store.set({ path: filePath, startLine: start, endLine: end, lines: parsed.lines.slice(start - 1, end) });
  };

  for (const line of sorted.slice(1)) {
    if (line === end + 1) {
      end = line;
      continue;
    }
    flush();
    start = line;
    end = line;
  }
  flush();
}

async function observeGrep(event: ToolResultEvent, cwd: string, store: SnapshotStore, signal?: AbortSignal): Promise<void> {
  if (!isGrepToolResult(event) || event.isError) return;
  if (event.details?.linesTruncated || event.details?.truncation?.truncated) return;
  if (event.content.some((item) => item.type === "image")) return;
  const invocationRevision = store.revision();

  const text = event.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const rows = text.split("\n");
  const footerStart = rows.indexOf("");
  const outputRows = (footerStart === -1 ? rows : rows.slice(0, footerStart)).filter((row) => row.length > 0);
  if (outputRows.length === 0 || outputRows[0] === "No matches found") return;

  const rawSearchPath = typeof event.input.path === "string" && event.input.path ? event.input.path : ".";
  const searchPath = await resolveCanonicalPath(cwd, rawSearchPath);
  signal?.throwIfAborted();

  let searchIsDirectory: boolean;
  try {
    searchIsDirectory = (await fs.stat(searchPath)).isDirectory();
  } catch {
    return;
  }

  const files = new Map<string, Promise<ParsedFile | undefined>>();
  const observed = new Map<string, { parsed: ParsedFile; lines: number[] }>();
  const getFile = (filePath: string) => {
    let pending = files.get(filePath);
    if (!pending) {
      pending = readTextFile(filePath, signal);
      files.set(filePath, pending);
    }
    return pending;
  };

  for (const row of outputRows) {
    const matches = new Map<string, { path: string; line: number; parsed: ParsedFile }>();
    for (const marker of markerCandidates(row)) {
      let filePath: string;
      if (searchIsDirectory) {
        const resolved = path.resolve(searchPath, marker.displayPath);
        if (!isWithin(searchPath, resolved)) continue;
        filePath = await resolveCanonicalPath(searchPath, marker.displayPath);
        if (!isWithin(searchPath, filePath)) continue;
      } else {
        if (marker.displayPath !== path.basename(searchPath)) continue;
        filePath = searchPath;
      }

      const parsed = await getFile(filePath);
      if (!parsed || parsed.lines[marker.line - 1] !== marker.text) continue;
      matches.set(`${filePath}\0${marker.line}`, { path: filePath, line: marker.line, parsed });
    }

    if (matches.size !== 1) return;
    const match = [...matches.values()][0]!;
    const existing = observed.get(match.path);
    if (existing) existing.lines.push(match.line);
    else observed.set(match.path, { parsed: match.parsed, lines: [match.line] });
  }

  signal?.throwIfAborted();
  if (store.revision() !== invocationRevision) return;
  for (const [filePath, observation] of observed) {
    setLineSnapshots(store, filePath, observation.parsed, observation.lines);
  }
}

export async function observeToolResult(event: ToolResultEvent, cwd: string, store: SnapshotStore, signal?: AbortSignal): Promise<void> {
  if (event.isError) return;

  if (isEditToolResult(event) || isWriteToolResult(event)) {
    const rawPath = typeof event.input.path === "string" ? event.input.path : undefined;
    if (!rawPath) return;
    store.clear(await resolveCanonicalPath(cwd, rawPath));
    return;
  }

  await observeGrep(event, cwd, store, signal);
}

export const toolResultObserverInternals = { markerCandidates };
