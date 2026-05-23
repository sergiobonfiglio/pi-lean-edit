import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";
import { formatNumberedLines, isBinary, resolveCanonicalPath, splitText } from "./line-utils.ts";
import { type SnapshotStore, snapshotStore } from "./snapshot-store.ts";

export const smartReadSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" }))
});
export type SmartReadInput = Static<typeof smartReadSchema>;

export type SmartReadConfig = {
  maxLines: number;
  maxBytes: number;
};

export type SmartReadResult = {
  text: string;
  details: {
    smartRead: {
      path: string;
      startLine: number;
      endLine: number;
      linesShown: number;
      totalLines: number;
      truncated: boolean;
    };
    truncation?: {
      content: string;
      truncated: boolean;
      truncatedBy: "lines" | "bytes" | null;
      totalLines: number;
      totalBytes: number;
      outputLines: number;
      outputBytes: number;
      lastLinePartial: boolean;
      firstLineExceedsLimit: boolean;
      maxLines: number;
      maxBytes: number;
    };
  };
};

function truncateRendered(lines: string[], startLine: number, limit: number, maxBytes: number): { shown: string[]; truncatedByBytes: boolean; firstLinePartial: boolean } {
  const shown: string[] = [];
  let bytes = 0;
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    const prefix = `${startLine + i} │ `;
    const line = lines[i]!;
    const rendered = `${prefix}${line}`;
    const nextBytes = Buffer.byteLength(shown.length === 0 ? rendered : `\n${rendered}`, "utf8");
    if (shown.length > 0 && bytes + nextBytes > maxBytes) return { shown, truncatedByBytes: true, firstLinePartial: false };
    if (shown.length === 0 && nextBytes > maxBytes) {
      return { shown: [], truncatedByBytes: true, firstLinePartial: true };
    }
    shown.push(line);
    bytes += nextBytes;
  }
  return { shown, truncatedByBytes: false, firstLinePartial: false };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be an integer >= 1`);
  return n;
}

export async function smartRead(cwd: string, input: SmartReadInput, config: SmartReadConfig, store: SnapshotStore = snapshotStore): Promise<SmartReadResult> {
  const full = await resolveCanonicalPath(cwd, input.path);
  const st = await fs.stat(full);
  if (st.isDirectory()) throw new Error(`Cannot read directory: ${input.path}`);
  const buf = await fs.readFile(full);
  if (isBinary(buf)) throw new Error("smart read supports text only");

  const text = buf.toString("utf8");
  const parsed = splitText(text);
  const startLine = positiveInteger(input.offset, 1, "offset");
  const requestedLimit = positiveInteger(input.limit, config.maxLines, "limit");
  const limit = Math.min(requestedLimit, config.maxLines);
  const available = startLine <= parsed.lines.length ? parsed.lines.slice(startLine - 1) : [];
  const { shown, truncatedByBytes, firstLinePartial } = truncateRendered(available, startLine, limit, config.maxBytes);
  const endLine = shown.length === 0 ? startLine - 1 : startLine + shown.length - 1;
  const truncated = truncatedByBytes || shown.length < available.length;

  if (shown.length > 0 && !firstLinePartial) {
    store.set({
      path: full,
      readAt: Date.now(),
      startLine,
      endLine,
      lines: shown,
      lineEnding: parsed.lineEnding
    });
  }

  const numbered = formatNumberedLines(shown, startLine);
  const partialNote = firstLinePartial ? `Line ${startLine} exceeds ${config.maxBytes} byte read limit; full line not shown or stored for edit. Use bash to inspect that line before editing.` : "";
  const summary = `Showing lines ${shown.length ? `${startLine}-${endLine}` : "0-0"} of ${parsed.lines.length}${truncated ? " (truncated)" : ""}.`;
  const next = truncated && !firstLinePartial ? `Continue with offset=${endLine + 1}.` : "";
  const out = [numbered, partialNote, summary, next].filter(Boolean).join("\n");
  const outputBytes = Buffer.byteLength(out, "utf8");

  return {
    text: out,
    details: {
      smartRead: { path: input.path, startLine, endLine, linesShown: shown.length, totalLines: parsed.lines.length, truncated },
      truncation: {
        content: out,
        truncated,
        truncatedBy: truncated ? (truncatedByBytes ? "bytes" : "lines") : null,
        totalLines: parsed.lines.length,
        totalBytes: buf.length,
        outputLines: out.length ? out.split("\n").length : 0,
        outputBytes,
        lastLinePartial: firstLinePartial,
        firstLineExceedsLimit: firstLinePartial,
        maxLines: config.maxLines,
        maxBytes: config.maxBytes
      }
    }
  };
}
