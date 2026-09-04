import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LineEnding = "\n" | "\r\n";

export type SplitText = {
  lines: string[];
  lineEnding: LineEnding;
  finalNewline: boolean;
  bom: string;
};

export function expandPath(filePath: string): string {
  // Unicode spaces are valid filename characters, so preserve them exactly.
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
  return normalized;
}

export async function resolveCanonicalPath(cwd: string, filePath: string): Promise<string> {
  const expanded = expandPath(filePath);
  const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
  return fs.realpath(resolved).catch(() => resolved);
}

export function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function decodeUtf8(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new Error("file is not valid UTF-8 text");
  }
}

export function fingerprintBytes(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function splitText(text: string): SplitText {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = bom ? text.slice(1) : text;
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  const lineEnding: LineEnding = crlfIndex !== -1 && crlfIndex < lfIndex ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  if (normalized.length === 0) return { lines: [], lineEnding, finalNewline: false, bom };
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, lineEnding, finalNewline, bom };
}
export function replacementLines(newText: string): string[] {
  if (newText.length === 0) return [];
  const normalized = newText.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function joinText(lines: string[], lineEnding: LineEnding, finalNewline: boolean, bom = ""): string {
  if (lines.length === 0) return bom;
  return bom + lines.join(lineEnding) + (finalNewline ? lineEnding : "");
}

export function sliceRange(lines: string[], startLine: number, endLine: number): string[] {
  return lines.slice(startLine - 1, endLine);
}

export function rangeText(lines: string[], startLine: number, endLine: number, lineEnding: LineEnding): string {
  return sliceRange(lines, startLine, endLine).join(lineEnding);
}


export function formatNumberedLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i} │ ${line}`).join("\n");
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _point of text) length++;
  return length;
}

function columnOffsets(text: string, startColumn: number, endColumn: number): { start: number; end: number } {
  let start = text.length;
  let end = text.length;
  let column = 1;
  let offset = 0;
  for (const point of text) {
    if (column === startColumn) start = offset;
    offset += point.length;
    if (column === endColumn) {
      end = offset;
      break;
    }
    column++;
  }
  return { start, end };
}

export function sliceColumns(text: string, startColumn: number, endColumn: number): string {
  const offsets = columnOffsets(text, startColumn, endColumn);
  return text.slice(offsets.start, offsets.end);
}

export function replaceColumns(text: string, startColumn: number, endColumn: number, newText: string): string {
  const offsets = columnOffsets(text, startColumn, endColumn);
  return text.slice(0, offsets.start) + newText + text.slice(offsets.end);
}

export function formatColumnLine(line: number, startColumn: number, endColumn: number, text: string): string {
  return `${line}:${startColumn}-${endColumn} │ ${text}`;
}
