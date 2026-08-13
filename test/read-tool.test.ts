import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { smartRead, smartReadSchema } from "../src/read-tool.ts";

async function tempFile(name: string, content: Buffer): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-smart-read-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return { dir, file: await fs.realpath(file) };
}

test("read schema requires only path and labels all range fields optional", () => {
  const schema = smartReadSchema as unknown as {
    required: string[];
    properties: Record<string, { description: string }>;
  };
  assert.deepEqual(schema.required, ["path"]);
  for (const field of ["offset", "limit", "columnOffset", "columnLimit"]) {
    assert.match(schema.properties[field]!.description, /^Optional\./);
  }
});
test("supported images are returned as image attachments", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3ioAAAAASUVORK5CYII=", "base64");
  const { dir, file } = await tempFile("tiny.png", png);
  const result = await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400, autoResizeImages: false });

  assert.deepEqual(result.details, {});
  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /Read image file \[image\/png\]/);
  assert.deepEqual(result.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
});

test("supported images are handled with default auto-resize config", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3ioAAAAASUVORK5CYII=", "base64");
  const { dir, file } = await tempFile("tiny-default.png", png);
  const result = await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });

  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /Read image file \[image\/png\]/);
});

test("resize failure omits image attachment like built-in read", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3ioAAAAASUVORK5CYII=", "base64");
  const { dir, file } = await tempFile("tiny-omit.png", png);
  const result = await smartRead(dir, { path: file }, {
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
  const result = await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });

  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /1 │ GIF parser notes/);
  assert.equal(result.content[1], undefined);
});

test("text files starting with RIFF...WEBP stay readable as text", async () => {
  const text = Buffer.from("RIFFxxxxWEBP notes about format\n", "utf8");
  const { dir, file } = await tempFile("riff.txt", text);
  const result = await smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });

  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { type: "text"; text: string }).text, /1 │ RIFFxxxxWEBP notes about format/);
  assert.equal(result.content[1], undefined);
});

test("non-image binary files are still rejected", async () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const { dir, file } = await tempFile("data.bin", binary);
  await assert.rejects(() => smartRead(dir, { path: file }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 }), /supports text only, except supported images/);
});
