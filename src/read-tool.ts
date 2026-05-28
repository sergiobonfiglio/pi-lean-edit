import { promises as fs } from "node:fs";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { codePointLength, formatColumnLine, formatNumberedLines, isBinary, resolveCanonicalPath, sliceColumns, splitText } from "./line-utils.ts";
import { type SnapshotStore, snapshotStore } from "./snapshot-store.ts";

export const smartReadSchema = Type.Object({
  path: Type.String({ description: "Path to file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
  columnOffset: Type.Optional(Type.Integer({ minimum: 1, description: "Column number to start reading from within offset line (1-indexed)" })),
  columnLimit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of columns to read from offset line" }))
});
export type SmartReadInput = Static<typeof smartReadSchema>;

export type SmartReadConfig = {
  maxLines: number;
  maxBytes: number;
  maxColumns?: number;
  autoResizeImages?: boolean;
};

type SmartReadDeps = {
  resizeImageFn?: typeof resizeImage;
};

type SmartReadContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type SmartReadResult = {
  content: SmartReadContent[];
  details: {
    smartRead?: {
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

const DEFAULT_MAX_COLUMNS = 400;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be an integer >= 1`);
  return n;
}

function effectiveMaxColumns(config: SmartReadConfig, inputLimit?: number): number {
  const configured = positiveInteger(config.maxColumns, DEFAULT_MAX_COLUMNS, "maxColumns");
  return Math.min(configured, positiveInteger(inputLimit, configured, "columnLimit"));
}

function fullLineBytes(lineNumber: number, line: string): number {
  return Buffer.byteLength(`${lineNumber} │ ${line}`, "utf8");
}

function fitColumnWindow(lineNumber: number, line: string, startColumn: number, maxColumns: number, byteBudget: number): { endColumn: number; text: string } {
  const lineLength = codePointLength(line);
  if (startColumn > lineLength) throw new Error(`columnOffset ${startColumn} exceeds line ${lineNumber} length ${lineLength}`);
  const maxTake = Math.min(maxColumns, lineLength - startColumn + 1);
  let bestEnd = startColumn;
  let bestText = "";
  for (let take = 1; take <= maxTake; take++) {
    const endColumn = startColumn + take - 1;
    const text = sliceColumns(line, startColumn, endColumn);
    const rendered = formatColumnLine(lineNumber, startColumn, endColumn, text);
    if (Buffer.byteLength(rendered, "utf8") > byteBudget) break;
    bestEnd = endColumn;
    bestText = text;
  }
  if (bestText.length === "".length) {
    const text = sliceColumns(line, startColumn, startColumn);
    return { endColumn: startColumn, text };
  }
  return { endColumn: bestEnd, text: bestText };
}

function renderSummary(startLine: number, endLine: number, totalLines: number, truncated: boolean, startColumn?: number, endColumn?: number): string {
  const range = startColumn != null && endColumn != null && startLine === endLine
    ? `${startLine}:${startColumn}-${endColumn}`
    : startColumn != null && endColumn != null
      ? `${startLine}-${endLine}:${endColumn}`
      : startLine <= endLine
        ? `${startLine}-${endLine}`
        : "0-0";
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

function imageReadResult(text: string, image?: { data: string; mimeType: string }): SmartReadResult {
  return {
    content: image ? [{ type: "text", text }, { type: "image", data: image.data, mimeType: image.mimeType }] : [{ type: "text", text }],
    details: {}
  };
}

export async function smartRead(cwd: string, input: SmartReadInput, config: SmartReadConfig, store: SnapshotStore = snapshotStore, model?: { input?: string[] }, deps: SmartReadDeps = {}): Promise<SmartReadResult> {
  const full = await resolveCanonicalPath(cwd, input.path);
  const st = await fs.stat(full);
  if (st.isDirectory()) throw new Error(`Cannot read directory: ${input.path}`);

  const buf = await fs.readFile(full);
  const imageMimeType = detectSupportedImageMimeType(buf);
  const nonVisionImageNote = getNonVisionImageNote(model);
  if (imageMimeType) {
    if (config.autoResizeImages ?? true) {
      const resized = await (deps.resizeImageFn ?? resizeImage)(buf, imageMimeType);
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

  if (isBinary(buf)) throw new Error("smart read supports text only, except supported images");

  const text = buf.toString("utf8");
  const parsed = splitText(text);
  const startLine = positiveInteger(input.offset, 1, "offset");
  const requestedLimit = positiveInteger(input.limit, config.maxLines, "limit");
  const limit = Math.min(requestedLimit, config.maxLines);
  const maxColumns = effectiveMaxColumns(config, input.columnLimit);

  if (input.columnOffset != null && input.limit != null && input.limit > 1) throw new Error("columnOffset only supports one line; omit limit or set limit=1");

  if (input.columnOffset != null) {
    if (startLine > parsed.lines.length) {
      const out = renderSummary(startLine, startLine - 1, parsed.lines.length, false);
      return {
        content: [{ type: "text", text: out }],
        details: {
          smartRead: { path: input.path, startLine, endLine: startLine - 1, linesShown: 0, totalLines: parsed.lines.length, truncated: false },
          truncation: {
            content: out,
            truncated: false,
            truncatedBy: null,
            totalLines: parsed.lines.length,
            totalBytes: buf.length,
            outputLines: out.length ? out.split("\n").length : 0,
            outputBytes: Buffer.byteLength(out, "utf8"),
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines: config.maxLines,
            maxBytes: config.maxBytes
          }
        }
      };
    }

    const line = parsed.lines[startLine - 1]!;
    const lineLength = codePointLength(line);
    const startColumn = positiveInteger(input.columnOffset, 1, "columnOffset");
    const { endColumn, text: windowText } = fitColumnWindow(startLine, line, startColumn, maxColumns, config.maxBytes);
    const truncated = endColumn < lineLength;
    const hugeLine = fullLineBytes(startLine, line) > config.maxBytes;
    store.setColumns({
      path: full,
      readAt: Date.now(),
      line: startLine,
      startColumn,
      endColumn,
      text: windowText,
      lineLength,
      lineEnding: parsed.lineEnding,
      hugeLine
    });

    const numbered = formatColumnLine(startLine, startColumn, endColumn, windowText);
    const summary = renderSummary(startLine, startLine, parsed.lines.length, truncated, startColumn, endColumn);
    const next = truncated ? `Continue with offset=${startLine} columnOffset=${endColumn + 1}.` : "";
    const out = [numbered, summary, next].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text: out }],
      details: {
        smartRead: { path: input.path, startLine, endLine: startLine, linesShown: 1, totalLines: parsed.lines.length, truncated, startColumn, endColumn },
        truncation: {
          content: out,
          truncated,
          truncatedBy: truncated ? "columns" : null,
          totalLines: parsed.lines.length,
          totalBytes: buf.length,
          outputLines: out.length ? out.split("\n").length : 0,
          outputBytes: Buffer.byteLength(out, "utf8"),
          lastLinePartial: truncated,
          firstLineExceedsLimit: hugeLine,
          maxLines: config.maxLines,
          maxBytes: config.maxBytes
        }
      }
    };
  }

  const shown: string[] = [];
  let bytesUsed = 0;
  let truncatedBy: "lines" | "bytes" | "columns" | null = null;
  let hugeLineInfo: { lineNumber: number; startColumn: number; endColumn: number; text: string; lineLength: number } | undefined;

  for (let i = 0; i < limit && startLine + i <= parsed.lines.length; i++) {
    const lineNumber = startLine + i;
    const line = parsed.lines[lineNumber - 1]!;
    const rendered = `${lineNumber} │ ${line}`;
    const lineBytes = Buffer.byteLength(shown.length === 0 ? rendered : `\n${rendered}`, "utf8");
    const lineIsHuge = fullLineBytes(lineNumber, line) > config.maxBytes;

    if (lineIsHuge) {
      const byteBudget = Math.max(1, config.maxBytes - bytesUsed);
      const lineLength = codePointLength(line);
      const { endColumn, text: windowText } = fitColumnWindow(lineNumber, line, 1, maxColumns, byteBudget);
      hugeLineInfo = { lineNumber, startColumn: 1, endColumn, text: windowText, lineLength };
      store.setColumns({
        path: full,
        readAt: Date.now(),
        line: lineNumber,
        startColumn: 1,
        endColumn,
        text: windowText,
        lineLength,
        lineEnding: parsed.lineEnding,
        hugeLine: true
      });
      truncatedBy = "columns";
      break;
    }

    if (bytesUsed + lineBytes > config.maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    shown.push(line);
    bytesUsed += lineBytes;
  }

  if (shown.length > 0) {
    store.set({
      path: full,
      readAt: Date.now(),
      startLine,
      endLine: startLine + shown.length - 1,
      lines: shown,
      lineEnding: parsed.lineEnding
    });
  }

  const exhaustedRequestedLines = shown.length === limit && !hugeLineInfo;
  const reachedEOF = startLine + shown.length > parsed.lines.length;
  const truncated = truncatedBy != null || (!reachedEOF && !exhaustedRequestedLines && startLine <= parsed.lines.length + 1) || (exhaustedRequestedLines && startLine + shown.length - 1 < parsed.lines.length);
  if (truncatedBy == null && exhaustedRequestedLines && startLine + shown.length - 1 < parsed.lines.length) truncatedBy = "lines";

  const numberedLines = shown.length > 0 ? formatNumberedLines(shown, startLine) : "";
  const hugeRendered = hugeLineInfo ? formatColumnLine(hugeLineInfo.lineNumber, hugeLineInfo.startColumn, hugeLineInfo.endColumn, hugeLineInfo.text) : "";
  const endLine = hugeLineInfo ? hugeLineInfo.lineNumber : shown.length === 0 ? startLine - 1 : startLine + shown.length - 1;
  const summary = hugeLineInfo
    ? renderSummary(startLine, hugeLineInfo.lineNumber, parsed.lines.length, true, hugeLineInfo.startColumn, hugeLineInfo.endColumn)
    : renderSummary(startLine, endLine, parsed.lines.length, truncated);
  const next = hugeLineInfo
    ? `Continue with offset=${hugeLineInfo.lineNumber} columnOffset=${hugeLineInfo.endColumn + 1}.`
    : truncated
      ? `Continue with offset=${endLine + 1}.`
      : "";
  const out = [numberedLines, hugeRendered, summary, next].filter(Boolean).join("\n");
  const outputBytes = Buffer.byteLength(out, "utf8");

  return {
    content: [{ type: "text", text: out }],
    details: {
      smartRead: {
        path: input.path,
        startLine,
        endLine,
        linesShown: shown.length + (hugeLineInfo ? 1 : 0),
        totalLines: parsed.lines.length,
        truncated,
        startColumn: hugeLineInfo?.startColumn,
        endColumn: hugeLineInfo?.endColumn
      },
      truncation: {
        content: out,
        truncated,
        truncatedBy,
        totalLines: parsed.lines.length,
        totalBytes: buf.length,
        outputLines: out.length ? out.split("\n").length : 0,
        outputBytes,
        lastLinePartial: Boolean(hugeLineInfo),
        firstLineExceedsLimit: Boolean(hugeLineInfo && hugeLineInfo.lineNumber === startLine && shown.length === 0),
        maxLines: config.maxLines,
        maxBytes: config.maxBytes
      }
    }
  };
}
