import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { smartRead, smartReadSchema } from "./read-tool.ts";
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

function renderSmartReadCall(args: any, theme: any, context: any) {
  let text = theme.fg("toolTitle", theme.bold("read "));
  text += theme.fg("accent", args?.path ?? "");
  const summary = context?.state?.smartReadSummary;
  if (summary && summary.path === args?.path) {
    text += theme.fg("dim", `:${summary.startLine}-${summary.endLine}`);
  } else if (args?.offset != null) {
    const start = Number(args.offset);
    const end = args?.limit != null ? start + Number(args.limit) - 1 : undefined;
    text += theme.fg("dim", `:${start}${end != null ? `-${end}` : ""}`);
  }

  if (summary && summary.path === args?.path) text += theme.fg("success", ` ${formatLineCount(Number(summary.linesShown ?? 0))}`);
  return new Text(text, 0, 0);
}

function renderSmartReadResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
  if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
  const item = result?.content?.[0];
  if (item?.type !== "text") return new Container();
  const text = item.text;
  if (result?.isError) return new Text(theme.fg("error", text.split("\n")[0] ?? text), 0, 0);

  const summary = result?.details?.smartRead;
  if (summary) {
    const stateKey = JSON.stringify([summary.path, summary.linesShown, summary.startLine, summary.endLine]);
    if (context.state.smartReadSummaryKey !== stateKey) {
      context.state.smartReadSummaryKey = stateKey;
      context.state.smartReadSummary = summary;
      context.invalidate();
    }
  }

  if (!expanded) return new Container();
  return new Text(text.split("\n").map((line: string) => theme.fg("dim", line)).join("\n"), 0, 0);
}

function renderSmartEditCall(args: any, theme: any, context: any) {
  let text = theme.fg("toolTitle", theme.bold("edit "));
  text += theme.fg("accent", args?.path ?? "");
  const ranges = Array.isArray(args?.edits)
    ? args.edits.map((edit: any) => {
      const start = edit?.startLine;
      const end = edit?.endLine ?? start;
      return start != null ? `${start}${end !== start ? `-${end}` : ""}` : null;
    }).filter(Boolean)
    : (() => {
      const start = args?.startLine;
      const end = args?.endLine ?? start;
      return start != null ? [`${start}${end !== start ? `-${end}` : ""}`] : [];
    })();
  if (ranges.length) text += theme.fg("dim", `:${ranges.join(",")}`);

  const stat = context?.state?.smartEditStat;
  if (stat && typeof stat.added === "number" && typeof stat.removed === "number") {
    const forceNumber = stat.added > 20 || stat.removed > 20;
    text += ` ${theme.fg("muted", `${stat.added + stat.removed} `)}${theme.fg("success", diffStatMarks(stat.added, "+", forceNumber))}${theme.fg("error", diffStatMarks(stat.removed, "-", forceNumber))}`;
  }
  return new Text(text, 0, 0);
}

function renderSmartEditResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
  if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);
  const item = result?.content?.[0];
  if (item?.type !== "text") return new Text("", 0, 0);
  const text = item.text;
  const lines = text.split("\n");
  if (result?.isError) {
    const first = lines.shift() ?? text;
    let rendered = theme.fg("error", first);
    if (lines.length) rendered += "\n" + lines.map((line: string) => theme.fg("dim", line)).join("\n");
    return new Text(rendered, 0, 0);
  }

  const diff = result?.details?.diff;
  if (typeof diff === "string" && diff.length > 0) {
    const stat = diffStat(diff);
    const stateKey = JSON.stringify([result?.details?.firstChangedLine, stat.added, stat.removed]);
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
  return `smart_edit session saved=${snapshot.session.charsSaved} failure=${(snapshot.session.failureRate * 100).toFixed(1)}% global saved=${snapshot.global.charsSaved} failure=${(snapshot.global.failureRate * 100).toFixed(1)}%`;
}

export default function (pi: ExtensionAPI) {
  const config = {
    maxLines: Number(process.env.PI_SMART_EDIT_MAX_READ_LINES ?? 2000),
    maxBytes: Number(process.env.PI_SMART_EDIT_MAX_READ_BYTES ?? 50_000)
  };
  const metrics = new SmartEditMetricsStore();

  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read text file contents with line numbers.",
    promptSnippet: "Read file contents with line numbers.",
    promptGuidelines: [
      "read: use offset/limit to inspect exact lines you may edit."
    ],
    parameters: smartReadSchema,
    renderShell: "default",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await smartRead(ctx.cwd, params, config);
        return { content: [{ type: "text", text: result.text }], details: result.details };
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
    description: "Edit a text file by one or more 1-based inclusive line ranges.",
    promptSnippet: "Edit lines: { path, startLine, endLine?, newText } or { path, edits: [...] }.",
    promptGuidelines: [
      "edit: use after read for same file/ranges; if stale/range-miss, read again.",
      "edit: use edits[] for multiple non-overlapping ranges; omit endLine for one line; newText: \"\" deletes."
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

  pi.registerCommand("smart-edit-stats", {
    description: "Show smart edit session/global failure rate and saved characters.",
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
      systemPrompt: event.systemPrompt + "\n\nSmart editing: use read before edit. edit applies one or more 1-based inclusive line ranges; stale/range-miss means read again. newText: \"\" deletes. /smart-edit-stats shows metrics."
    };
  });
}
