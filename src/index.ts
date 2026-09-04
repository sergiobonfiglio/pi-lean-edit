import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { createWriteToolDefinition, getAgentDir, getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, getCapabilities, getImageDimensions, imageFallback, type SettingItem } from "@earendil-works/pi-tui";
import { leanRead, leanReadSchema, type LeanReadResult } from "./read-tool.ts";
import { leanEdit, leanEditSchema, prepareLeanEditArguments, StaleEditError, type LeanEditResult } from "./edit-tool.ts";
import { leanEditHugeLine, leanEditHugeLineSchema, leanReadHugeLine, leanReadHugeLineSchema } from "./huge-line-tools.ts";
import { failureDelta, formatLeanEditStats, LeanEditMetricsStore, type LeanEditDelta, type LeanEditMetricsSnapshot } from "./metrics.ts";
import { diffStat } from "./diff.ts";
import { renderDiffForLeanEdit } from "./diff-render.ts";
import { asExpansionLevel, renderWithExpansion, type ExpansionLevel } from "./render-expansion.ts";
import { resolveCanonicalPath } from "./line-utils.ts";
import { SnapshotStore } from "./snapshot-store.ts";
import { observeToolResult } from "./tool-result-observer.ts";

function mergeMetricsDetails(details: Record<string, any>, delta: LeanEditDelta, snapshot: LeanEditMetricsSnapshot): Record<string, any> {
  return { ...details, leanEditMetrics: { delta, snapshot } };
}

function formatLineCount(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function diffStatMarks(count: number, mark: string, forceNumber = false): string {
  if (!forceNumber && count <= 20) return mark.repeat(count);
  return `${mark}${count}`;
}

type LeanReadCallArgs = { path?: string; offset?: number; limit?: number; line?: number; columnOffset?: number };

type LeanEditCallArgs = {
  path?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  edits?: Array<{ startLine?: number; endLine?: number }>;
};
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;
type ToolResult<TDetails = Record<string, unknown>> = {
  content?: ToolContent[];
  details?: TDetails & Record<string, unknown>;
  isError?: boolean;
};

type LeanReadRenderState = {
  leanReadSummary?: NonNullable<LeanReadResult["details"]["leanRead"]>;
  leanReadSummaryKey?: string;
};

type LeanEditRenderState = {
  leanEditStat?: { added: number; removed: number };
  leanEditSummaryKey?: string;
};

function renderLeanReadCall(args: LeanReadCallArgs, theme: any, context: { state: LeanReadRenderState }, toolName = "read") {
  let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
  text += theme.fg("accent", args?.path ?? "");
  const summary = context?.state?.leanReadSummary;
  if (summary && summary.path === args?.path) {
    const suffix = summary.startColumn != null && summary.endColumn != null
      ? `:${summary.startLine}:${summary.startColumn}-${summary.endColumn}`
      : `:${summary.startLine}-${summary.endLine}`;
    text += theme.fg("dim", suffix);
  } else {
    const start = args?.line ?? args?.offset;
    if (start != null) {
      if (args?.columnOffset != null) text += theme.fg("dim", `:${Number(start)}:${Number(args.columnOffset)}`);
      else {
        const end = args?.limit != null ? Number(start) + Number(args.limit) - 1 : undefined;
        text += theme.fg("dim", `:${Number(start)}${end != null ? `-${end}` : ""}`);
      }
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
function getLeanReadTextOutput(result: ToolResult, showImages: boolean): string {
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

function renderLeanReadResult(result: ToolResult<LeanReadResult["details"]>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any, context: { showImages: boolean; state: LeanReadRenderState; invalidate: () => void }) {
  if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
  const text = getLeanReadTextOutput(result, context.showImages);
  if (!text) return new Container();
  if (result.isError) return new Text(theme.fg("error", text.split("\n")[0] ?? text), 0, 0);

  const summary = result.details?.leanRead;
  if (summary) {
    const stateKey = JSON.stringify([summary.path, summary.linesShown, summary.startLine, summary.endLine, summary.startColumn, summary.endColumn]);
    if (context.state.leanReadSummaryKey !== stateKey) {
      context.state.leanReadSummaryKey = stateKey;
      context.state.leanReadSummary = summary;
      context.invalidate();
    }
  }

  if (!expanded) return new Container();
  return dimLines(text, theme);
}

function formatEditRange(edit: { startLine?: number; endLine?: number; startColumn?: number; endColumn?: number }): string | null {
  const start = edit.startLine ?? (edit as { line?: number }).line;
  const end = edit.endLine ?? start;
  if (start == null || end == null) return null;
  const linePart = `${start}${end !== start ? `-${end}` : ""}`;
  return edit.startColumn != null && edit.endColumn != null ? `${linePart}:${edit.startColumn}-${edit.endColumn}` : linePart;
}

function formatEditRanges(args: LeanEditCallArgs): string[] {
  if (Array.isArray(args.edits)) return args.edits.map(formatEditRange).filter((range): range is string => Boolean(range));
  const range = formatEditRange(args);
  return range ? [range] : [];
}

function renderLeanEditCall(args: LeanEditCallArgs, theme: any, context: { state: LeanEditRenderState }, toolName = "edit") {
  let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
  text += theme.fg("accent", args?.path ?? "");
  const ranges = formatEditRanges(args);
  if (ranges.length) text += theme.fg("dim", `:${ranges.join(",")}`);

  const stat = context?.state?.leanEditStat;
  if (stat && typeof stat.added === "number" && typeof stat.removed === "number") {
    const forceNumber = stat.added > 20 || stat.removed > 20;
    text += ` ${theme.fg("muted", `${stat.added + stat.removed} `)}${theme.fg("success", diffStatMarks(stat.added, "+", forceNumber))}${theme.fg("error", diffStatMarks(stat.removed, "-", forceNumber))}`;
  }
  return new Text(text, 0, 0);
}

function renderLeanEditResult(result: ToolResult<{ diff?: string; firstChangedLine?: number }>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any, context: { state: LeanEditRenderState; invalidate: () => void }) {
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
    if (context.state.leanEditSummaryKey !== stateKey) {
      context.state.leanEditSummaryKey = stateKey;
      context.state.leanEditStat = stat;
      context.invalidate();
    }
    if (expanded) return new Text("\n" + renderDiffForLeanEdit(diff, theme), 0, 0);
    return new Container();
  }

  return new Text(theme.fg("success", lines[0] || "Applied"), 0, 0);
}

function statsLine(snapshot: LeanEditMetricsSnapshot): string {
  return `lean_edit session saved=${snapshot.session.charsSaved} failure=${(snapshot.session.failureRate * 100).toFixed(1)}% global saved=${snapshot.global.charsSaved} failure=${(snapshot.global.failureRate * 100).toFixed(1)}%`;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export default function (pi: ExtensionAPI) {
  const config = {
    maxLines: positiveIntegerEnv("PI_LEAN_EDIT_MAX_READ_LINES", 2000),
    maxBytes: positiveIntegerEnv("PI_LEAN_EDIT_MAX_READ_BYTES", 50_000),
    maxColumns: positiveIntegerEnv("PI_LEAN_EDIT_MAX_READ_COLUMNS", 400)
  };
  // Product feature: per-tool rendering preferences are intentionally configurable and persisted.
  const expansionTools = ["read", "edit", "write"] as const;
  const renderModes = ["collapsed", "expanded"] as const;
  type ExpansionTool = typeof expansionTools[number];
  type RenderMode = typeof renderModes[number];
  const renderingSettings: Record<RenderMode, Record<ExpansionTool, ExpansionLevel>> = {
    collapsed: { read: "minimal", edit: "minimal", write: "minimal" },
    expanded: { read: "minimal", edit: "full", write: "medium" }
  };
  const expansionSettingsPath = join(getAgentDir(), "pi-lean-edit", "settings.json");
  const loadExpansionSettings = async () => {
    try {
      const saved = JSON.parse(await fs.readFile(expansionSettingsPath, "utf8")) as Partial<Record<RenderMode, Record<string, unknown>>>;
      for (const mode of renderModes) {
        for (const tool of expansionTools) renderingSettings[mode][tool] = asExpansionLevel(saved?.[mode]?.[tool], renderingSettings[mode][tool]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const saveExpansionSettings = async () => {
    await fs.mkdir(dirname(expansionSettingsPath), { recursive: true });
    await fs.writeFile(expansionSettingsPath, `${JSON.stringify(renderingSettings, null, 2)}\n`, "utf8");
  };
  const renderLevel = (tool: ExpansionTool, expanded: boolean) => renderingSettings[expanded ? "expanded" : "collapsed"][tool];
  const writeTool = createWriteToolDefinition(process.cwd());
  // Product feature: session and global savings metrics are intentionally retained across runs.
  const metrics = new LeanEditMetricsStore();
  let snapshots = new SnapshotStore();
  const ownedMutationCalls = new Set<string>();
  const recordMetrics = async (delta: LeanEditDelta): Promise<{ snapshot: LeanEditMetricsSnapshot; warning?: string }> => {
    try {
      return { snapshot: await metrics.record(delta) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { snapshot: metrics.snapshot(), warning: `Warning: Could not persist lean-edit metrics: ${message}` };
    }
  };
  const executeEdit = async (run: () => Promise<LeanEditResult>) => {
    try {
      const result = await run();
      const { snapshot, warning } = await recordMetrics(result.delta);
      return {
        content: [{ type: "text" as const, text: [result.text, statsLine(snapshot), warning].filter(Boolean).join("\n") }],
        details: mergeMetricsDetails({ diff: result.diff, firstChangedLine: result.firstChangedLine }, result.delta, snapshot)
      };
    } catch (error) {
      const { snapshot, warning } = await recordMetrics(failureDelta());
      const message = error instanceof StaleEditError
        ? `${error.message}\nCurrent text:\n${error.refreshedText}\nIf this is the text you meant to replace, retry the same edit.`
        : error instanceof Error ? error.message : String(error);
      throw new Error([message, statsLine(snapshot), warning].filter(Boolean).join("\n"));
    }
  };
  pi.registerTool<typeof leanReadSchema, LeanReadResult["details"], LeanReadRenderState>({
    name: "read",
    label: "read",
    description: "Read normal text files with optional line ranges, or supported images as attachments. Huge lines are not partially snapshotted; use read_huge_line for those.",
    promptSnippet: "Read normal file contents; path is required and offset/limit are optional.",
    promptGuidelines: [
      "read: path is the only required argument.",
      "read: use offset/limit to inspect exact full lines you may edit.",
      "read: when a line exceeds the output limit, use read_huge_line for a bounded column window."
    ],
    parameters: leanReadSchema,
    renderShell: "default",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await leanRead(ctx.cwd, params, config, snapshots, ctx?.model, {}, signal);
      return { content: result.content, details: result.details };
    },
    renderCall(args, theme, context) {
      return renderWithExpansion(renderLevel("read", context.expanded), context, (adjusted) => renderLeanReadCall(args, theme, adjusted));
    },
    renderResult(result, options, theme, context) {
      return renderWithExpansion(renderLevel("read", options.expanded), context, (adjusted) =>
        renderLeanReadResult(result, { ...options, expanded: adjusted.expanded }, theme, adjusted)
      );
    }
  });

  pi.registerTool<typeof leanEditSchema, { diff?: string; firstChangedLine?: number }, LeanEditRenderState>({
    name: "edit",
    label: "edit",
    description: "Edit one or more non-overlapping inclusive full-line ranges previously shown by read or a complete grep result.",
    promptSnippet: "Edit full-line ranges with { path, edits: [{ startLine, endLine?, newText }] }.",
    promptGuidelines: [
      "edit: use after read or a complete, untruncated grep result for the same file/ranges; if requested text was not read or has changed, edit returns the current text without applying; retry only if that is the text you meant to replace.",
      "edit: successful replacement content can be reused immediately; deletions add no replacement rows; same-count edits preserve unaffected rows, while line-count changes conservatively invalidate old suffix coverage.",
      "edit: always use edits[]; use one item for a single edit and multiple non-overlapping items for a batch; newText: \"\" deletes.",
      "edit: ranges are full lines. Use edit_huge_line for a bounded range within a huge line."
    ],
    parameters: leanEditSchema,
    prepareArguments: prepareLeanEditArguments,
    renderShell: "default",
    async execute(id, params, signal, _onUpdate, ctx) {
      ownedMutationCalls.add(id);
      return executeEdit(() => leanEdit(ctx.cwd, params, snapshots, config, signal));
    },
    renderCall(args, theme, context) {
      return renderWithExpansion(renderLevel("edit", context.expanded), context, (adjusted) => renderLeanEditCall(args, theme, adjusted));
    },
    renderResult(result, options, theme, context) {
      return renderWithExpansion(renderLevel("edit", options.expanded), context, (adjusted) =>
        renderLeanEditResult(result, { ...options, expanded: adjusted.expanded }, theme, adjusted)
      );
    }
  });

  pi.registerTool<typeof leanReadHugeLineSchema, LeanReadResult["details"], LeanReadRenderState>({
    name: "read_huge_line",
    label: "read_huge_line",
    description: "Read one bounded code-point column window from a huge text line. Rejects normal-sized lines; use read for those.",
    promptSnippet: "Read a huge-line window with { path, line, columnOffset?, columnLimit? }.",
    promptGuidelines: [
      "read_huge_line: use only after read reports that a line exceeds its byte limit.",
      "read_huge_line: adjacent or overlapping windows combine into coverage for edit_huge_line."
    ],
    parameters: leanReadHugeLineSchema,
    renderShell: "default",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await leanReadHugeLine(ctx.cwd, params, config, snapshots, signal);
      return { content: result.content, details: result.details };
    },
    renderCall(args, theme, context) {
      return renderWithExpansion(renderLevel("read", context.expanded), context, (adjusted) => renderLeanReadCall(args, theme, adjusted, "read_huge_line"));
    },
    renderResult(result, options, theme, context) {
      return renderWithExpansion(renderLevel("read", options.expanded), context, (adjusted) =>
        renderLeanReadResult(result, { ...options, expanded: adjusted.expanded }, theme, adjusted)
      );
    }
  });

  pi.registerTool<typeof leanEditHugeLineSchema, { diff?: string; firstChangedLine?: number }, LeanEditRenderState>({
    name: "edit_huge_line",
    label: "edit_huge_line",
    description: "Edit one inclusive code-point column range previously shown by read_huge_line. Replacement text must stay on one line.",
    promptSnippet: "Edit one huge-line range with { path, line, startColumn, endColumn, newText }.",
    promptGuidelines: [
      "edit_huge_line: use only after read_huge_line covered the exact range.",
      "edit_huge_line: supports one range and forbids newline insertion; empty newText deletes the range."
    ],
    parameters: leanEditHugeLineSchema,
    renderShell: "default",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return executeEdit(() => leanEditHugeLine(ctx.cwd, params, snapshots, config, signal));
    },
    renderCall(args, theme, context) {
      return renderWithExpansion(renderLevel("edit", context.expanded), context, (adjusted) => renderLeanEditCall(args, theme, adjusted, "edit_huge_line"));
    },
    renderResult(result, options, theme, context) {
      return renderWithExpansion(renderLevel("edit", options.expanded), context, (adjusted) =>
        renderLeanEditResult(result, { ...options, expanded: adjusted.expanded }, theme, adjusted)
      );
    }
  });

  pi.registerTool<typeof writeTool.parameters, undefined>({
    ...writeTool,
    async execute(id, params, signal, onUpdate, ctx) {
      ownedMutationCalls.add(id);
      const canonicalPath = await resolveCanonicalPath(ctx.cwd, params.path);
      const result = await createWriteToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      snapshots.clear(canonicalPath);
      return result;
    },
    renderCall(args, theme, context) {
      return renderWithExpansion(renderLevel("write", context.expanded), context, (adjusted) =>
        writeTool.renderCall!(args, theme, adjusted)
      );
    },
    renderResult(result, options, theme, context) {
      return renderWithExpansion(renderLevel("write", options.expanded), context, (adjusted) =>
        writeTool.renderResult!(result, { ...options, expanded: adjusted.expanded }, theme, adjusted)
      );
    }
  });

  pi.registerCommand("lean-edit-settings", {
    description: "Configure collapsed and expanded rendering for read, edit, and write.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/lean-edit-settings is available in interactive mode.", "warning");
        return;
      }

      const settingsEntries = renderModes.flatMap((mode) => expansionTools.map((tool) => ({ mode, tool, id: `${mode}.${tool}` })));
      const items: SettingItem[] = settingsEntries.map(({ mode, tool, id }) => ({
        id,
        label: `${tool} ${mode}`,
        currentValue: renderingSettings[mode][tool],
        values: ["minimal", "medium", "full"]
      }));
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Lean edit rendering")), 1, 1));
        const settingsList = new SettingsList(
          items,
          items.length + 2,
          getSettingsListTheme(),
          (id, value) => {
            const setting = settingsEntries.find((candidate) => candidate.id === id);
            if (setting) renderingSettings[setting.mode][setting.tool] = asExpansionLevel(value, renderingSettings[setting.mode][setting.tool]);
          },
          () => done(undefined)
        );
        container.addChild(settingsList);
        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          }
        };
      });

      try {
        await saveExpansionSettings();
        ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
        ctx.ui.notify("Lean edit rendering settings saved.", "info");
      } catch (error) {
        ctx.ui.notify(`Could not save lean edit settings: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("lean-edit-stats", {
    description: "Show lean edit session/global failure rate and saved characters.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatLeanEditStats(metrics.snapshot()), "info");
    }
  });


  pi.on("tool_result", async (event, ctx) => {
    if (ownedMutationCalls.delete(event.toolCallId)) return;
    await observeToolResult(event, ctx.cwd, snapshots, ctx.signal);
  });

  pi.on("session_start", async (_event, ctx) => {
    snapshots = new SnapshotStore();
    ownedMutationCalls.clear();
    try {
      await loadExpansionSettings();
    } catch (error) {
      ctx.ui.notify(`Could not load lean edit settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    try {
      await metrics.loadGlobal();
    } catch (error) {
      ctx.ui.notify(`Could not load lean edit metrics: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    metrics.rebuildSession(ctx.sessionManager.getBranch());
  });


  pi.on("session_tree", (_event, ctx) => {
    snapshots = new SnapshotStore();
    ownedMutationCalls.clear();
    metrics.rebuildSession(ctx.sessionManager.getBranch());
  });

  pi.on("session_compact", () => {
    snapshots = new SnapshotStore();
    ownedMutationCalls.clear();
  });
}
