import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import registerExtension from "../src/index.ts";

function registerTools(
  metricsPath: string,
  events = new Map<string, (...args: any[]) => any>(),
  commands = new Map<string, any>()
): Map<string, any> {
  const tools = new Map<string, any>();
  const previousMetricsPath = process.env.PI_LEAN_EDIT_METRICS_PATH;
  process.env.PI_LEAN_EDIT_METRICS_PATH = metricsPath;
  try {
    registerExtension({
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); }
    } as any);
  } finally {
    if (previousMetricsPath == null) delete process.env.PI_LEAN_EDIT_METRICS_PATH;
    else process.env.PI_LEAN_EDIT_METRICS_PATH = previousMetricsPath;
  }
  return tools;
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-edit-extension-"));
}

test("registered read execute throws failures instead of returning pseudo-errors", async () => {
  const dir = await tempDir();
  const tools = registerTools(path.join(dir, "metrics.json"));
  const readTool = tools.get("read");

  await assert.rejects(
    () => readTool.execute("read-id", { path: "missing.txt" }, undefined, undefined, { cwd: dir }),
    /ENOENT/
  );
});

test("registered edit execute throws with stale guidance and recorded metrics", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  const metricsPath = path.join(dir, "metrics.json");
  await fs.writeFile(file, "before\n", "utf8");
  const tools = registerTools(metricsPath);
  const editTool = tools.get("edit");
  const prepared = editTool.prepareArguments({ path: file, startLine: 1, newText: "after" });
  assert.deepEqual(prepared, { path: file, edits: [{ startLine: 1, newText: "after" }] });

  await assert.rejects(
    () => editTool.execute("edit-id", prepared, undefined, undefined, { cwd: dir }),
    (error: any) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /edit not applied: one or more requested ranges were not read beforehand\./);
      assert.match(error.message, /Current text:\n1 │ before/);
      assert.match(error.message, /If this is the text you meant to replace, retry the same edit\./);
      assert.match(error.message, /lean_edit session saved=0 failure=100\.0% global saved=0 failure=100\.0%/);
      return true;
    }
  );

  assert.equal(await fs.readFile(file, "utf8"), "before\n");
  const metrics = JSON.parse(await fs.readFile(metricsPath, "utf8"));
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.failures, 1);
});

test("metrics persistence failure does not turn an applied edit into a tool failure", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  const metricsPath = path.join(dir, "metrics.json");
  await fs.writeFile(file, "before\n", "utf8");
  await fs.writeFile(metricsPath, "not json", "utf8");
  const tools = registerTools(metricsPath);
  const readTool = tools.get("read");
  const editTool = tools.get("edit");

  await readTool.execute("read-id", { path: file }, undefined, undefined, { cwd: dir });
  const first = await editTool.execute("edit-id", { path: file, edits: [{ startLine: 1, newText: "after" }] }, undefined, undefined, { cwd: dir });
  assert.match(first.content[0].text, /Applied edit/);
  assert.match(first.content[0].text, /Could not persist lean-edit metrics/);
  assert.equal(await fs.readFile(file, "utf8"), "after\n");

  await fs.writeFile(metricsPath, "{}", "utf8");
  const second = await editTool.execute("edit-id-2", { path: file, edits: [{ startLine: 1, newText: "again" }] }, undefined, undefined, { cwd: dir });
  assert.doesNotMatch(second.content[0].text, /Could not persist lean-edit metrics/);
  assert.equal(await fs.readFile(file, "utf8"), "again\n");
});

test("snapshot reads are isolated between extension instances", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, "before\n", "utf8");
  const firstTools = registerTools(path.join(dir, "first-metrics.json"));
  const secondTools = registerTools(path.join(dir, "second-metrics.json"));

  await firstTools.get("read").execute("read-id", { path: file }, undefined, undefined, { cwd: dir });
  await assert.rejects(
    () => secondTools.get("edit").execute("edit-id", { path: file, edits: [{ startLine: 1, newText: "after" }] }, undefined, undefined, { cwd: dir }),
    /one or more requested ranges were not read beforehand/
  );
  assert.equal(await fs.readFile(file, "utf8"), "before\n");
});

test("conversation context changes clear prior read snapshots", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, "before\n", "utf8");
  const events = new Map<string, (...args: any[]) => any>();
  const tools = registerTools(path.join(dir, "metrics.json"), events);

  await tools.get("read").execute("read-id", { path: file }, undefined, undefined, { cwd: dir });
  events.get("session_tree")!({}, { sessionManager: { getBranch: () => [] } });
  await assert.rejects(
    () => tools.get("edit").execute("edit-id", { path: file, edits: [{ startLine: 1, newText: "after" }] }, undefined, undefined, { cwd: dir }),
    /one or more requested ranges were not read beforehand/
  );
});

test("extension registers dedicated huge-line tools with separated schemas", async () => {
  const dir = await tempDir();
  const tools = registerTools(path.join(dir, "metrics.json"));
  assert.deepEqual([...tools.keys()].sort(), ["edit", "edit_huge_line", "read", "read_huge_line", "write"]);
  assert.deepEqual(Object.keys(tools.get("read").parameters.properties), ["path", "offset", "limit"]);
  assert.deepEqual(Object.keys(tools.get("edit").parameters.properties.edits.items.properties), ["startLine", "endLine", "newText"]);
  assert.deepEqual(Object.keys(tools.get("read_huge_line").parameters.properties), ["path", "line", "columnOffset", "columnLimit"]);
  assert.deepEqual(Object.keys(tools.get("edit_huge_line").parameters.properties), ["path", "line", "startColumn", "endColumn", "newText"]);
});

test("registered huge-line read and edit share snapshot coverage", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "huge.txt");
  await fs.writeFile(file, `${"0123456789".repeat(6000)}\n`, "utf8");
  const tools = registerTools(path.join(dir, "metrics.json"));
  await tools.get("read_huge_line").execute("read-huge", { path: file, line: 1, columnOffset: 5, columnLimit: 6 }, undefined, undefined, { cwd: dir });
  await tools.get("edit_huge_line").execute("edit-huge", { path: file, line: 1, startColumn: 6, endColumn: 8, newText: "xyz" }, undefined, undefined, { cwd: dir });
  assert.match(await fs.readFile(file, "utf8"), /^01234xyz89/);
});

test("registered read and edit honor aborted signals", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, "before\n", "utf8");
  const tools = registerTools(path.join(dir, "metrics.json"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => tools.get("read").execute("read", { path: file }, controller.signal, undefined, { cwd: dir }),
    /abort/i
  );
  await assert.rejects(
    () => tools.get("edit").execute("edit", { path: file, edits: [{ startLine: 1, newText: "after" }] }, controller.signal, undefined, { cwd: dir }),
    /abort/i
  );
  assert.equal(await fs.readFile(file, "utf8"), "before\n");
});

test("extension rejects invalid read-limit environment variables", () => {
  for (const name of [
    "PI_LEAN_EDIT_MAX_READ_LINES",
    "PI_LEAN_EDIT_MAX_READ_BYTES",
    "PI_LEAN_EDIT_MAX_READ_COLUMNS"
  ]) {
    const previous = process.env[name];
    process.env[name] = "0";
    try {
      assert.throws(() => registerExtension({} as any), new RegExp(`${name} must be a positive integer`));
    } finally {
      if (previous == null) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test("write invalidates snapshots before a positional edit can target shifted duplicate text", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, "x\na\n", "utf8");
  const tools = registerTools(path.join(dir, "metrics.json"));
  const ctx = { cwd: dir };
  await tools.get("read").execute("read", { path: file }, undefined, undefined, ctx);
  await tools.get("write").execute("write", { path: file, content: "y\na\na\n" }, undefined, undefined, ctx);
  await assert.rejects(
    () => tools.get("edit").execute("edit", { path: file, edits: [{ startLine: 2, newText: "B" }] }, undefined, undefined, ctx),
    /not read beforehand/
  );
  assert.equal(await fs.readFile(file, "utf8"), "y\na\na\n");
});


test("a complete grep result seeds a later positional edit", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, "alpha\nneedle\nomega\n", "utf8");
  const events = new Map<string, (...args: any[]) => any>();
  const tools = registerTools(path.join(dir, "metrics.json"), events);
  const ctx = { cwd: dir };

  await events.get("tool_result")!({
    type: "tool_result",
    toolCallId: "grep-id",
    toolName: "grep",
    input: { pattern: "needle", path: dir },
    content: [{ type: "text", text: "file.txt:2: needle" }],
    details: undefined,
    isError: false
  }, ctx);
  await tools.get("edit").execute("edit-id", {
    path: file,
    edits: [{ startLine: 2, newText: "found" }]
  }, undefined, undefined, ctx);

  assert.equal(await fs.readFile(file, "utf8"), "alpha\nfound\nomega\n");
});

test("tool-result observation preserves owned edit seeds and invalidates external mutations", async () => {
  const dir = await tempDir();
  const first = path.join(dir, "first.txt");
  const second = path.join(dir, "second.txt");
  await fs.writeFile(first, "one\n", "utf8");
  await fs.writeFile(second, "two\n", "utf8");
  const events = new Map<string, (...args: any[]) => any>();
  const tools = registerTools(path.join(dir, "metrics.json"), events);
  const ctx = { cwd: dir };

  await tools.get("read").execute("read-first", { path: first }, undefined, undefined, ctx);
  await tools.get("read").execute("read-second", { path: second }, undefined, undefined, ctx);
  const ownedResult = await tools.get("edit").execute("owned-edit", {
    path: first,
    edits: [{ startLine: 1, newText: "ONE" }]
  }, undefined, undefined, ctx);
  await events.get("tool_result")!({
    type: "tool_result",
    toolCallId: "owned-edit",
    toolName: "edit",
    input: { path: first },
    content: ownedResult.content,
    details: ownedResult.details,
    isError: false
  }, ctx);
  await tools.get("edit").execute("owned-edit-again", {
    path: first,
    edits: [{ startLine: 1, newText: "ONE AGAIN" }]
  }, undefined, undefined, ctx);

  await events.get("tool_result")!({
    type: "tool_result",
    toolCallId: "external-edit",
    toolName: "edit",
    input: { path: second, edits: [{ oldText: "two", newText: "two" }] },
    content: [{ type: "text", text: "Applied edit to second.txt" }],
    details: { diff: "", patch: "" },
    isError: false
  }, ctx);
  await assert.rejects(
    () => tools.get("edit").execute("edit-second", {
      path: second,
      edits: [{ startLine: 1, newText: "TWO" }]
    }, undefined, undefined, ctx),
    /not read beforehand/
  );
  assert.equal(await fs.readFile(first, "utf8"), "ONE AGAIN\n");
  assert.equal(await fs.readFile(second, "utf8"), "two\n");
});
test("tree navigation rebuilds session metrics from the active branch", async () => {
  const dir = await tempDir();
  const metricsPath = path.join(dir, "metrics.json");
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = registerTools(metricsPath, events, commands);
  const notifications: string[] = [];
  const ctx = {
    cwd: dir,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getBranch: () => [] }
  };
  await events.get("session_start")!({}, ctx);
  await tools.get("edit").execute("edit", { path: path.join(dir, "missing.txt"), edits: [{ startLine: 1, newText: "x" }] }, undefined, undefined, ctx).catch(() => {});
  await commands.get("lean-edit-stats").handler("", ctx);
  assert.match(notifications.at(-1)!, /session\s+1\s+1/);

  events.get("session_tree")!({}, ctx);
  await commands.get("lean-edit-stats").handler("", ctx);
  assert.match(notifications.at(-1)!, /session\s+0\s+0/);
});
