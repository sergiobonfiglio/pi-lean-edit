import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { leanRead, leanReadSchema } from "../src/read-tool.ts";

async function tempFile(name: string, content: Buffer): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-read-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return { dir, file: await fs.realpath(file) };
}

test("supported images are returned as image attachments", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3ioAAAAASUVORK5CYII=", "base64");
  const { dir, file } = await tempFile("tiny.png", png);
  const result = await leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400, autoResizeImages: false });

  assert.deepEqual(result.details, {});
  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /Read image file \[image\/png\]/);
  assert.deepEqual(result.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
});

test("supported images are handled with default auto-resize config", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3ioAAAAASUVORK5CYII=", "base64");
  const { dir, file } = await tempFile("tiny-default.png", png);
  const result = await leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });

  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /Read image file \[image\/png\]/);
});

test("resize failure omits image attachment like built-in read", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3ioAAAAASUVORK5CYII=", "base64");
  const { dir, file } = await tempFile("tiny-omit.png", png);
  const result = await leanRead(dir, { path: file }, {
    maxLines: 2000,
    maxBytes: 50_000,
    maxColumns: 400
  }, undefined, undefined, { resizeImageFn: async () => null });

  assert.deepEqual(result.content, [{
    type: "text",
    text: "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]"
  }]);
});

test("text files starting with GIF stay readable as text", async () => {
  const text = Buffer.from("GIF parser notes\nline two\n", "utf8");
  const { dir, file } = await tempFile("notes.txt", text);
  const result = await leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });

  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /1 │ GIF parser notes/);
  assert.equal(result.content[1], undefined);
});

test("text files starting with RIFF...WEBP stay readable as text", async () => {
  const text = Buffer.from("RIFFxxxxWEBP notes about format\n", "utf8");
  const { dir, file } = await tempFile("riff.txt", text);
  const result = await leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });

  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /1 │ RIFFxxxxWEBP notes about format/);
  assert.equal(result.content[1], undefined);
});

test("non-image binary files are still rejected", async () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const { dir, file } = await tempFile("data.bin", binary);
  await assert.rejects(() => leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 }), /supports text only, except supported images/);
});


test("read schema exposes only normal line-range fields", () => {
  const schema = leanReadSchema as unknown as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(schema.required, ["path"]);
  assert.deepEqual(Object.keys(schema.properties), ["path", "offset", "limit"]);
});

test("normal read stops before a huge line without snapshotting a partial line", async () => {
  const { dir, file } = await tempFile("huge.txt", Buffer.from(`one\n${"x".repeat(80)}\nthree\n`, "utf8"));
  const result = await leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 20, maxColumns: 6 });
  const content = result.content[0];
  assert.equal(content?.type, "text");
  if (content?.type !== "text") return;
  assert.match(content.text, /1 │ one/);
  assert.match(content.text, /Line 2 exceeds the read byte limit\. Use read_huge_line/);
  assert.doesNotMatch(content.text, /x{6}/);
  assert.equal(result.details.truncation?.firstLineExceedsLimit, false);
});

test("aborted read does not create a snapshot", async () => {
  const { dir, file } = await tempFile("abort.txt", Buffer.from("text\n", "utf8"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => leanRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000 }, undefined, undefined, {}, controller.signal),
    (error: any) => error?.name === "AbortError"
  );
});

test("Unicode spaces in file names are preserved", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lean-read-space-"));
  await fs.writeFile(path.join(dir, "a b"), "ascii space\n", "utf8");
  await fs.writeFile(path.join(dir, "a\u00A0b"), "non-breaking space\n", "utf8");
  const result = await leanRead(dir, { path: "a\u00A0b" }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });
  const content = result.content[0];
  assert.equal(content?.type, "text");
  if (content?.type === "text") assert.match(content.text, /non-breaking space/);
});
