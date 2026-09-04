import { promises as fs } from "node:fs";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { formatNumberedLines, isBinary, resolveCanonicalPath, splitText } from "./line-utils.ts";
import { SnapshotStore, snapshotStore } from "./snapshot-store.ts";

export const leanReadSchema = Type.Object({
  path: Type.String({ description: "Required. Path to the file to read (relative or absolute)." }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Optional. 1-indexed line at which to start reading." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Optional. Maximum number of lines to read." }))
}, { additionalProperties: false });
export type LeanReadInput = Static<typeof leanReadSchema>;

export type LeanReadConfig = {
  maxLines: number;
  maxBytes: number;
  maxColumns?: number;
  autoResizeImages?: boolean;
};

type LeanReadDeps = {
  resizeImageFn?: typeof resizeImage;
};

type LeanReadContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type LeanReadResult = {
  content: LeanReadContent[];
  details: {
    leanRead?: {
      path: string;
      startLine: number;
      endLine: number;
      linesShown: number;
      totalLines: number;
      truncated: boolean;
      startColumn?: number;
      endColumn?: number;
    };
    truncation?: {
      content: string;
      truncated: boolean;
      truncatedBy: "lines" | "bytes" | "columns" | null;
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


function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be an integer >= 1`);
  return n;
}


function renderSummary(startLine: number, endLine: number, totalLines: number, truncated: boolean): string {
  const range = startLine <= endLine ? `${startLine}-${endLine}` : "0-0";
  return `Showing lines ${range} of ${totalLines}${truncated ? " (truncated)" : ""}.`;
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return ((buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0));
}

function isPng(buffer: Uint8Array): boolean {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return buffer.length >= 16 && startsWith(buffer, pngSignature) && readUint32BE(buffer, pngSignature.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  const pngSignatureLength = 8;
  let offset = pngSignatureLength;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function isGif(buffer: Uint8Array): boolean {
  return buffer.length >= 10 && (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a"));
}

function isWebP(buffer: Uint8Array): boolean {
  return buffer.length >= 16 &&
    startsWithAscii(buffer, 0, "RIFF") &&
    startsWithAscii(buffer, 8, "WEBP") &&
    (startsWithAscii(buffer, 12, "VP8 ") || startsWithAscii(buffer, 12, "VP8L") || startsWithAscii(buffer, 12, "VP8X"));
}

function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? null : "image/jpeg";
  if (startsWith(buffer, pngSignature)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  if (isGif(buffer)) return "image/gif";
  if (isWebP(buffer)) return "image/webp";
  return null;
}

function getNonVisionImageNote(model: { input?: string[] } | undefined): string | undefined {
  if (!model || model.input?.includes("image")) return undefined;
  return "[Current model does not support images. The image will be omitted from this request.]";
}

function buildImageReadText(mimeType: string, notes: Array<string | undefined>): string {
  return [`Read image file [${mimeType}]`, ...notes.filter((note): note is string => Boolean(note))].join("\n");
}

function imageReadResult(text: string, image?: { data: string; mimeType: string }): LeanReadResult {
  return {
    content: image ? [{ type: "text", text }, { type: "image", data: image.data, mimeType: image.mimeType }] : [{ type: "text", text }],
    details: {}
  };
}

export async function leanRead(
  cwd: string,
  input: LeanReadInput,
  config: LeanReadConfig,
  store: SnapshotStore = snapshotStore,
  model?: { input?: string[] },
  deps: LeanReadDeps = {},
  signal?: AbortSignal
): Promise<LeanReadResult> {
  signal?.throwIfAborted();
  const full = await resolveCanonicalPath(cwd, input.path);
  signal?.throwIfAborted();
  const st = await fs.stat(full);
  if (st.isDirectory()) throw new Error(`Cannot read directory: ${input.path}`);

  const buf = await fs.readFile(full, { signal });
  const imageMimeType = detectSupportedImageMimeType(buf);
  const nonVisionImageNote = getNonVisionImageNote(model);
  if (imageMimeType) {
    if (config.autoResizeImages ?? true) {
      const resized = await (deps.resizeImageFn ?? resizeImage)(buf, imageMimeType);
      signal?.throwIfAborted();
      if (!resized) {
        return imageReadResult(buildImageReadText(imageMimeType, [
          "[Image omitted: could not be resized below the inline image size limit.]",
          nonVisionImageNote
        ]));
      }
      return imageReadResult(
        buildImageReadText(resized.mimeType, [formatDimensionNote(resized), nonVisionImageNote]),
        { data: resized.data, mimeType: resized.mimeType }
      );
    }

    return imageReadResult(
      buildImageReadText(imageMimeType, [nonVisionImageNote]),
      { data: buf.toString("base64"), mimeType: imageMimeType }
    );
  }

  if (isBinary(buf)) throw new Error("lean read supports text only, except supported images");

  const text = buf.toString("utf8");
  const parsed = splitText(text);
  const startLine = positiveInteger(input.offset, 1, "offset");
  const requestedLimit = positiveInteger(input.limit, config.maxLines, "limit");
  const limit = Math.min(requestedLimit, config.maxLines);
  const shown: string[] = [];
  let bytesUsed = 0;
  let truncatedBy: "lines" | "bytes" | "columns" | null = null;
  let hugeLine: number | undefined;

  for (let i = 0; i < limit && startLine + i <= parsed.lines.length; i++) {
    const lineNumber = startLine + i;
    const line = parsed.lines[lineNumber - 1]!;
    const rendered = `${lineNumber} │ ${line}`;
    const lineBytes = Buffer.byteLength(shown.length === 0 ? rendered : `\n${rendered}`, "utf8");
    if (Buffer.byteLength(rendered, "utf8") > config.maxBytes) {
      hugeLine = lineNumber;
      truncatedBy = "bytes";
      break;
    }
    if (bytesUsed + lineBytes > config.maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    shown.push(line);
    bytesUsed += lineBytes;
  }

  signal?.throwIfAborted();
  if (shown.length > 0) {
    store.set({
      path: full,
      startLine,
      endLine: startLine + shown.length - 1,
      lines: shown,
      lineEnding: parsed.lineEnding
    });
  }

  const exhaustedRequestedLines = shown.length === limit;
  const reachedEOF = startLine + shown.length > parsed.lines.length;
  const truncated = truncatedBy != null || (!reachedEOF && !exhaustedRequestedLines && startLine <= parsed.lines.length + 1) || (exhaustedRequestedLines && startLine + shown.length - 1 < parsed.lines.length);
  if (truncatedBy == null && exhaustedRequestedLines && startLine + shown.length - 1 < parsed.lines.length) truncatedBy = "lines";

  const endLine = shown.length === 0 ? startLine - 1 : startLine + shown.length - 1;
  const summary = renderSummary(startLine, endLine, parsed.lines.length, truncated);
  const next = hugeLine != null
    ? `Line ${hugeLine} exceeds the read byte limit. Use read_huge_line with line=${hugeLine} and columnOffset=1.`
    : truncated
      ? `Continue with offset=${endLine + 1}.`
      : "";
  const out = [formatNumberedLines(shown, startLine), summary, next].filter(Boolean).join("\n");

  return {
    content: [{ type: "text", text: out }],
    details: {
      leanRead: {
        path: input.path,
        startLine,
        endLine,
        linesShown: shown.length,
        totalLines: parsed.lines.length,
        truncated
      },
      truncation: {
        content: out,
        truncated,
        truncatedBy,
        totalLines: parsed.lines.length,
        totalBytes: buf.length,
        outputLines: out.length ? out.split("\n").length : 0,
        outputBytes: Buffer.byteLength(out, "utf8"),
        lastLinePartial: false,
        firstLineExceedsLimit: hugeLine === startLine,
        maxLines: config.maxLines,
        maxBytes: config.maxBytes
      }
    }
  };
}
