import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import registerExtension from "../src/index.ts";

function registerTools(metricsPath: string): Map<string, any> {
  const tools = new Map<string, any>();
  const previousMetricsPath = process.env.PI_LEAN_EDIT_METRICS_PATH;
  process.env.PI_LEAN_EDIT_METRICS_PATH = metricsPath;
  try {
    registerExtension({
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on() {}
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
