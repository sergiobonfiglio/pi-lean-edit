import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import { smartRead, smartReadSchema, type SmartReadResult } from "./read-tool.ts";
import { smartEdit, smartEditSchema } from "./edit-tool.ts";
import { failureDelta, formatSmartEditStats, SmartEditMetricsStore, type SmartEditDelta, type SmartEditMetricsSnapshot } from "./metrics.ts";
import { diffStat } from "./diff.ts";
import { renderDiffForSmartEdit } from "./diff-render.ts";

function mergeMetricsDetails(details: Record<string, any>, delta: SmartEditDelta, snapshot: SmartEditMetricsSnapshot): Record<string, any> {
  return { ...details, smartEditMetrics: { delta, snapshot } };
}

function formatLineCount(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function diffStatMarks(count: number, mark: string, forceNumber = false): string {
  if (!forceNumber && count <= 20) return mark.repeat(count);
  return `${mark}${count}`;
}

type SmartReadCallArgs = { path?: string; offset?: number; limit?: number; columnOffset?: number };

type SmartEditCallArgs = {
  path?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  edits?: Array<{
    startLine?: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
  }>;
};

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;
type ToolResult<TDetails = Record<string, unknown>> = {
  content?: ToolContent[];
  details?: TDetails & Record<string, unknown>;
  isError?: boolean;
};

type SmartReadRenderState = {
  smartReadSummary?: NonNullable<SmartReadResult["details"]["smartRead"]>;
  smartReadSummaryKey?: string;
};

type SmartEditRenderState = {
  smartEditStat?: { added: number; removed: number };
  smartEditSummaryKey?: string;
};

function renderSmartReadCall(args: SmartReadCallArgs, theme: any, context: { state: SmartReadRenderState }) {
  let text = theme.fg("toolTitle", theme.bold("read "));
  text += theme.fg("accent", args?.path ?? "");
  const summary = context?.state?.smartReadSummary;
  if (summary && summary.path === args?.path) {
    const suffix = summary.startColumn != null && summary.endColumn != null
      ? `:${summary.startLine}:${summary.startColumn}-${summary.endColumn}`
      : `:${summary.startLine}-${summary.endLine}`;
    text += theme.fg("dim", suffix);
  } else if (args?.offset != null) {
    const start = Number(args.offset);
    if (args?.columnOffset != null) text += theme.fg("dim", `:${start}:${Number(args.columnOffset)}`);
    else {
      const end = args?.limit != null ? start + Number(args.limit) - 1 : undefined;
      text += theme.fg("dim", `:${start}${end != null ? `-${end}` : ""}`);
    }
  }

  if (summary && summary.path === args?.path) text += theme.fg("success", ` ${formatLineCount(Number(summary.linesShown ?? 0))}`);
  return new Text(text, 0, 0);
}

function dimLines(text: string, theme: any): Text {
  return new Text(text.split("\n").map((line) => theme.fg("dim", line)).join("\n"), 0, 0);
}

function getTextItem(result: ToolResult): TextContent | undefined {
  const item = result.content?.[0];
  return item?.type === "text" ? item : undefined;
}

// Mirrors built-in read getTextOutput image fallback behavior when images are hidden/unsupported.
function getSmartReadTextOutput(result: ToolResult, showImages: boolean): string {
  if (!result) return "";
  const content = result.content ?? [];
  const textBlocks = content.filter((c): c is TextContent => c.type === "text");
  const imageBlocks = content.filter((c): c is ImageContent => c.type === "image");
  let output = textBlocks.map((c) => c.text.replace(/\r/g, "")).join("\n");
  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const fallbacks = imageBlocks.map((img) => {
      const dims = getImageDimensions(img.data, img.mimeType) ?? undefined;
      return imageFallback(img.mimeType, dims);
    }).join("\n");
    output = output ? `${output}\n${fallbacks}` : fallbacks;
  }
  return output;
}

function renderSmartReadResult(result: ToolResult<SmartReadResult["details"]>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any, context: { showImages: boolean; state: SmartReadRenderState; invalidate: () => void }) {
  if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
  const text = getSmartReadTextOutput(result, context.showImages);
  if (!text) return new Container();
  if (result.isError) return new Text(theme.fg("error", text.split("\n")[0] ?? text), 0, 0);

  const summary = result.details?.smartRead;
  if (summary) {
    const stateKey = JSON.stringify([summary.path, summary.linesShown, summary.startLine, summary.endLine]);
    if (context.state.smartReadSummaryKey !== stateKey) {
      context.state.smartReadSummaryKey = stateKey;
      context.state.smartReadSummary = summary;
      context.invalidate();
    }
  }

  if (!expanded) return new Container();
  return dimLines(text, theme);
}

function formatEditRange(edit: { startLine?: number; endLine?: number; startColumn?: number; endColumn?: number }): string | null {
  const start = edit.startLine;
  const end = edit.endLine ?? start;
  if (start == null || end == null) return null;
  const linePart = `${start}${end !== start ? `-${end}` : ""}`;
  return edit.startColumn != null && edit.endColumn != null ? `${linePart}:${edit.startColumn}-${edit.endColumn}` : linePart;
}

function formatEditRanges(args: SmartEditCallArgs): string[] {
  if (Array.isArray(args.edits)) return args.edits.map(formatEditRange).filter((range): range is string => Boolean(range));
  const range = formatEditRange(args);
  return range ? [range] : [];
}

function renderSmartEditCall(args: SmartEditCallArgs, theme: any, context: { state: SmartEditRenderState }) {
  let text = theme.fg("toolTitle", theme.bold("edit "));
  text += theme.fg("accent", args?.path ?? "");
  const ranges = formatEditRanges(args);
  if (ranges.length) text += theme.fg("dim", `:${ranges.join(",")}`);

  const stat = context?.state?.smartEditStat;
  if (stat && typeof stat.added === "number" && typeof stat.removed === "number") {
    const forceNumber = stat.added > 20 || stat.removed > 20;
    text += ` ${theme.fg("muted", `${stat.added + stat.removed} `)}${theme.fg("success", diffStatMarks(stat.added, "+", forceNumber))}${theme.fg("error", diffStatMarks(stat.removed, "-", forceNumber))}`;
  }
  return new Text(text, 0, 0);
}

function renderSmartEditResult(result: ToolResult<{ diff?: string; firstChangedLine?: number }>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any, context: { state: SmartEditRenderState; invalidate: () => void }) {
  if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);
  const item = getTextItem(result);
  if (!item) return new Text("", 0, 0);
  const text = item.text;
  const lines = text.split("\n");
  if (result.isError) {
    const first = lines.shift() ?? text;
    const rest = lines.length ? `\n${lines.map((line) => theme.fg("dim", line)).join("\n")}` : "";
    return new Text(theme.fg("error", first) + rest, 0, 0);
  }

  const diff = result.details?.diff;
  if (typeof diff === "string" && diff.length > 0) {
    const stat = diffStat(diff);
    const stateKey = JSON.stringify([result.details?.firstChangedLine, stat.added, stat.removed]);
    if (context.state.smartEditSummaryKey !== stateKey) {
      context.state.smartEditSummaryKey = stateKey;
      context.state.smartEditStat = stat;
      context.invalidate();
    }
    if (expanded) return new Text("\n" + renderDiffForSmartEdit(diff, theme), 0, 0);
    return new Container();
  }

  return new Text(theme.fg("success", lines[0] || "Applied"), 0, 0);
}

function statsLine(snapshot: SmartEditMetricsSnapshot): string {
  return `lean_edit session saved=${snapshot.session.charsSaved} failure=${(snapshot.session.failureRate * 100).toFixed(1)}% global saved=${snapshot.global.charsSaved} failure=${(snapshot.global.failureRate * 100).toFixed(1)}%`;
}

export default function (pi: ExtensionAPI) {
  const config = {
    maxLines: Number(process.env.PI_LEAN_EDIT_MAX_READ_LINES ?? 2000),
    maxBytes: Number(process.env.PI_LEAN_EDIT_MAX_READ_BYTES ?? 50_000),
    maxColumns: Number(process.env.PI_LEAN_EDIT_MAX_READ_COLUMNS ?? 400)
  };
  const metrics = new SmartEditMetricsStore();

  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read text file contents with line numbers or line-column windows for huge lines. Supports jpg, png, gif, and webp images as attachments.",
    promptSnippet: "Read file contents with line numbers or supported images.",
    promptGuidelines: [
      "read: use offset/limit to inspect exact lines you may edit.",
      "read: use columnOffset for huge single lines; continuation stays on same line until done."
    ],
    parameters: smartReadSchema,
    renderShell: "default",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await smartRead(ctx.cwd, params, config, undefined, ctx?.model);
        return { content: result.content, details: result.details };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true, details: {} };
      }
    },
    renderCall: renderSmartReadCall,
    renderResult: renderSmartReadResult
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit text file by one or more 1-based inclusive line ranges or single-line column ranges.",
    promptSnippet: "Edit lines or columns: { path, startLine, endLine?, startColumn?, endColumn?, newText } or { path, edits: [...] }.",
    promptGuidelines: [
      "edit: use after read for same file/ranges; if stale/range-miss, read again.",
      "edit: after success, edited ranges are invalidated; same-line-count edits keep unaffected later snapshots.",
      "edit: use edits[] for multiple non-overlapping ranges; omit endLine for one line; newText: \"\" deletes.",
      "edit: column edits stay within one line; huge-line column edits require matching column snapshot."
    ],
    parameters: smartEditSchema,
    renderShell: "default",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await smartEdit(ctx.cwd, params);
        const snapshot = await metrics.record(result.delta);
        const text = `${result.text}\n${statsLine(snapshot)}`;
        return {
          content: [{ type: "text", text }],
          details: mergeMetricsDetails({ diff: result.diff, firstChangedLine: result.firstChangedLine }, result.delta, snapshot)
        };
      } catch (e) {
        const delta = failureDelta();
        const snapshot = await metrics.record(delta);
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `${msg}\n${statsLine(snapshot)}` }],
          isError: true,
          details: mergeMetricsDetails({}, delta, snapshot)
        };
      }
    },
    renderCall: renderSmartEditCall,
    renderResult: renderSmartEditResult
  });

  pi.registerCommand("lean-edit-stats", {
    description: "Show lean edit session/global failure rate and saved characters.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSmartEditStats(metrics.snapshot()), "info");
    }
  });


  pi.on("session_start", async (_event, ctx) => {
    await metrics.loadGlobal();
    metrics.rebuildSession(ctx.sessionManager.getBranch());
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\nSmart editing: read before edit; use offset/limit and columnOffset/columnLimit as needed. Same-line-count edits keep unaffected later snapshots; stale/range-miss means read again. newText: \"\" deletes."
    };
  });
}
