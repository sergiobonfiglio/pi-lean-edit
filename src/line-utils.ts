import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LineEnding = "\n" | "\r\n";

export type SplitText = {
  lines: string[];
  lineEnding: LineEnding;
  finalNewline: boolean;
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function expandPath(filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  const spaces = normalized.replace(UNICODE_SPACES, " ");
  if (spaces === "~") return os.homedir();
  if (spaces.startsWith("~/")) return os.homedir() + spaces.slice(1);
  return spaces;
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

export function splitText(text: string): SplitText {
  const lineEnding: LineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  if (text.length === 0) return { lines: [], lineEnding, finalNewline: false };
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  return { lines, lineEnding, finalNewline };
}

export function hasMixedLineEndings(text: string): boolean {
  let sawLf = false;
  let sawCrlf = false;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    if (index > 0 && text[index - 1] === "\r") sawCrlf = true;
    else sawLf = true;
    if (sawLf && sawCrlf) return true;
  }
  return false;
}
export function replacementLines(newText: string): string[] {
  if (newText.length === 0) return [];
  const normalized = newText.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function joinText(lines: string[], lineEnding: LineEnding, finalNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(lineEnding) + (finalNewline ? lineEnding : "");
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
