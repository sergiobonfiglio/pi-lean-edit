import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { firstChangedLine, unifiedDiff } from "./diff.ts";
import { StaleEditError, type LeanEditConfig, type LeanEditResult } from "./edit-tool.ts";
import { withInterprocessFileMutationLock } from "./file-mutation-lock.ts";
import { codePointLength, formatColumnLine, hasMixedLineEndings, isBinary, joinText, replaceColumns, resolveCanonicalPath, sliceColumns, splitText } from "./line-utils.ts";
import type { LeanReadConfig, LeanReadResult } from "./read-tool.ts";
import { SnapshotStore, snapshotStore } from "./snapshot-store.ts";

export const leanReadHugeLineSchema = Type.Object({
  path: Type.String({ description: "Path to the text file to read (relative or absolute)." }),
  line: Type.Integer({ minimum: 1, description: "1-indexed huge line to read." }),
  columnOffset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed column at which to start the window. Defaults to 1." })),
  columnLimit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum columns to return, bounded by the configured limit." }))
}, { additionalProperties: false });
export type LeanReadHugeLineInput = Static<typeof leanReadHugeLineSchema>;

export const leanEditHugeLineSchema = Type.Object({
  path: Type.String({ description: "Path to edit, relative to cwd unless absolute." }),
  line: Type.Integer({ minimum: 1, description: "1-indexed huge line containing the range." }),
  startColumn: Type.Integer({ minimum: 1, description: "First code-point column to replace (1-based, inclusive)." }),
  endColumn: Type.Integer({ minimum: 1, description: "Last code-point column to replace (1-based, inclusive)." }),
  newText: Type.String({ description: "Single-line replacement text. Empty string deletes the range; newlines are not allowed." })
}, { additionalProperties: false });
export type LeanEditHugeLineInput = Static<typeof leanEditHugeLineSchema>;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be an integer >= 1`);
  return result;
}

function isHugeLine(lineNumber: number, line: string, maxBytes: number): boolean {
  return Buffer.byteLength(`${lineNumber} │ ${line}`, "utf8") > maxBytes;
}

function fitColumnWindow(lineNumber: number, line: string, startColumn: number, maxColumns: number, byteBudget: number): { endColumn: number; text: string; lineLength: number } {
  const points = Array.from(line);
  const lineLength = points.length;
  if (startColumn > lineLength) throw new Error(`columnOffset ${startColumn} exceeds line ${lineNumber} length ${lineLength}`);
  const selected: string[] = [];
  let selectedBytes = 0;
  let endColumn = startColumn - 1;
  const maxTake = Math.min(maxColumns, lineLength - startColumn + 1);
  for (let take = 1; take <= maxTake; take++) {
    const point = points[startColumn + take - 2]!;
    const candidateEnd = startColumn + take - 1;
    const candidateBytes = selectedBytes + Buffer.byteLength(point, "utf8");
    const prefixBytes = Buffer.byteLength(formatColumnLine(lineNumber, startColumn, candidateEnd, ""), "utf8");
    if (prefixBytes + candidateBytes > byteBudget) break;
    selected.push(point);
    selectedBytes = candidateBytes;
    endColumn = candidateEnd;
  }
  if (selected.length === 0) throw new Error("configured read byte limit is too small for this column window");
  return { endColumn, text: selected.join(""), lineLength };
}

async function readTextFile(path: string, signal?: AbortSignal): Promise<{ text: string; bytes: number }> {
  const buffer = await fs.readFile(path, { signal });
  if (isBinary(buffer)) throw new Error("huge-line tools support text files only");
  return { text: buffer.toString("utf8"), bytes: buffer.length };
}

export async function leanReadHugeLine(
  cwd: string,
  input: LeanReadHugeLineInput,
  config: LeanReadConfig,
  store: SnapshotStore = snapshotStore,
  signal?: AbortSignal
): Promise<LeanReadResult> {
  signal?.throwIfAborted();
  const full = await resolveCanonicalPath(cwd, input.path);
  signal?.throwIfAborted();
  const { text, bytes } = await readTextFile(full, signal);
  const parsed = splitText(text);
  const lineNumber = positiveInteger(input.line, 1, "line");
  const line = parsed.lines[lineNumber - 1];
  if (line == null) throw new Error(`line ${lineNumber} is beyond end of file`);
  if (!isHugeLine(lineNumber, line, config.maxBytes)) throw new Error(`line ${lineNumber} is not huge; use read instead`);
  const startColumn = positiveInteger(input.columnOffset, 1, "columnOffset");
  const configuredColumns = positiveInteger(config.maxColumns, 400, "maxColumns");
  const maxColumns = Math.min(configuredColumns, positiveInteger(input.columnLimit, configuredColumns, "columnLimit"));
  const window = fitColumnWindow(lineNumber, line, startColumn, maxColumns, config.maxBytes);
  signal?.throwIfAborted();
  store.setColumns({
    path: full,
    line: lineNumber,
    startColumn,
    endColumn: window.endColumn,
    text: window.text,
    lineLength: window.lineLength
  });

  const truncated = window.endColumn < window.lineLength;
  const out = [
    formatColumnLine(lineNumber, startColumn, window.endColumn, window.text),
    `Showing columns ${startColumn}-${window.endColumn} of line ${lineNumber} (${window.lineLength} columns)${truncated ? " (truncated)" : ""}.`,
    truncated ? `Continue with columnOffset=${window.endColumn + 1}.` : ""
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text", text: out }],
    details: {
      leanRead: {
        path: input.path,
        startLine: lineNumber,
        endLine: lineNumber,
        linesShown: 1,
        totalLines: parsed.lines.length,
        truncated,
        startColumn,
        endColumn: window.endColumn
      },
      truncation: {
        content: out,
        truncated,
        truncatedBy: truncated ? "columns" : null,
        totalLines: parsed.lines.length,
        totalBytes: bytes,
        outputLines: out.split("\n").length,
        outputBytes: Buffer.byteLength(out, "utf8"),
        lastLinePartial: truncated,
        firstLineExceedsLimit: true,
        maxLines: config.maxLines,
        maxBytes: config.maxBytes
      }
    }
  };
}

function validateHugeEdit(input: LeanEditHugeLineInput): void {
  positiveInteger(input.line, 1, "line");
  positiveInteger(input.startColumn, 1, "startColumn");
  positiveInteger(input.endColumn, 1, "endColumn");
  if (input.endColumn < input.startColumn) throw new Error("endColumn must be >= startColumn");
  if (typeof input.newText !== "string") throw new Error("newText must be a string");
  if (/[\r\n]/.test(input.newText)) throw new Error("edit_huge_line replacement text must not contain newlines; use a full-line edit after reading normal-sized text");
}

function hugeEditDelta(oldText: string, input: LeanEditHugeLineInput) {
  const charsNormalEdit = oldText.length + input.newText.length;
  const charsLeanEdit = `${input.line}${input.startColumn}${input.endColumn}`.length + input.newText.length;
  return { attempts: 1, failures: 0, charsSaved: Math.max(0, charsNormalEdit - charsLeanEdit), charsNormalEdit, charsLeanEdit };
}

export async function leanEditHugeLine(
  cwd: string,
  input: LeanEditHugeLineInput,
  store: SnapshotStore = snapshotStore,
  config: LeanEditConfig & Pick<LeanReadConfig, "maxColumns"> = { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 },
  signal?: AbortSignal
): Promise<LeanEditResult> {
  signal?.throwIfAborted();
  validateHugeEdit(input);
  const invocationRevision = store.revision();
  const full = await resolveCanonicalPath(cwd, input.path);
  signal?.throwIfAborted();
  if (store.revision(full) > invocationRevision) throw new Error("file stale, read again: snapshot changed while edit was starting");
  const initialSnapshot = store.coveredColumns(full, input.line, input.startColumn, input.endColumn);
  const initialRevision = store.revision(full);
  let cleanupWarning: string | undefined;

  const result = await withInterprocessFileMutationLock(full, () => withFileMutationQueue(full, async () => {
    signal?.throwIfAborted();
    if (store.revision(full) !== initialRevision) throw new Error("file stale, read again: snapshot changed while edit was queued");
    const { text: before } = await readTextFile(full, signal);
    signal?.throwIfAborted();
    if (hasMixedLineEndings(before)) throw new Error("cannot safely edit a file with mixed line endings");
    const parsed = splitText(before);
    const line = parsed.lines[input.line - 1];
    if (line == null) throw new Error("file stale, read again: requested line is beyond end of file");
    if (!isHugeLine(input.line, line, config.maxBytes)) throw new Error(`line ${input.line} is not huge; use read and edit instead`);
    if (input.endColumn > codePointLength(line)) throw new Error("file stale, read again: requested columns are beyond end of line");
    const actual = sliceColumns(line, input.startColumn, input.endColumn);
    const expected = initialSnapshot && sliceColumns(
      initialSnapshot.text,
      input.startColumn - initialSnapshot.startColumn + 1,
      input.endColumn - initialSnapshot.startColumn + 1
    );

    if (!initialSnapshot || expected !== actual) {
      const maxColumns = positiveInteger(config.maxColumns, 400, "maxColumns");
      const refreshed = formatColumnLine(input.line, input.startColumn, input.endColumn, actual);
      if (input.endColumn - input.startColumn + 1 > maxColumns || Buffer.byteLength(refreshed, "utf8") > config.maxBytes) {
        throw new Error("file stale, read again: updated range exceeds automatic refresh limits");
      }
      store.setColumns({
        path: full,
        line: input.line,
        startColumn: input.startColumn,
        endColumn: input.endColumn,
        text: actual,
        lineLength: codePointLength(line)
      });
      throw new StaleEditError(refreshed, initialSnapshot ? "the requested text changed since it was read" : "the requested range was not read beforehand");
    }

    const nextLines = [...parsed.lines];
    nextLines[input.line - 1] = replaceColumns(line, input.startColumn, input.endColumn, input.newText);
    const after = joinText(nextLines, parsed.lineEnding, parsed.finalNewline);
    signal?.throwIfAborted();
    await fs.writeFile(full, after, "utf8");
    store.invalidateRanges(full, [{ startLine: input.line, endLine: input.line }]);
    const replacementLength = codePointLength(input.newText);
    if (replacementLength > 0) {
      store.setColumns({
        path: full,
        line: input.line,
        startColumn: input.startColumn,
        endColumn: input.startColumn + replacementLength - 1,
        text: input.newText,
        lineLength: codePointLength(nextLines[input.line - 1]!)
      });
    }

    return {
      text: `Applied edit to ${input.path}:${input.line}:${input.startColumn}-${input.endColumn}`,
      diff: unifiedDiff(input.path, before, after),
      firstChangedLine: firstChangedLine(before, after),
      delta: hugeEditDelta(actual, input)
    };
  }), {
    signal,
    onCleanupError: (error) => {
      cleanupWarning = `Warning: Edit was applied, but the file lock could not be released cleanly: ${error instanceof Error ? error.message : String(error)}. Do not retry the edit blindly.`;
    }
  });

  return cleanupWarning ? { ...result, warning: cleanupWarning } : result;
}
