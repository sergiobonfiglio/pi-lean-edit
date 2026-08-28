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

test("multi-line reads ignore supplied column window parameters with a warning", async () => {
  const { dir, file } = await tempFile("mixed-range.txt", Buffer.from("alpha\nbravo\ncharlie\ndelta\n", "utf8"));
  const result = await smartRead(dir, {
    path: file,
    offset: 1,
    limit: 3,
    columnOffset: 2,
    columnLimit: 4
  }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });
  const content = result.content[0];

  assert.equal(content?.type, "text");
  if (content?.type !== "text") return;
  assert.match(content.text, /^1 │ alpha\n2 │ bravo\n3 │ charlie\n/);
  assert.match(content.text, /Warning: Ignored columnOffset=2 and columnLimit=4 because column windows support only one line while limit=3 requests multiple lines\.$/);
  assert.equal(result.details.smartRead?.startLine, 1);
  assert.equal(result.details.smartRead?.endLine, 3);
  assert.equal(result.details.smartRead?.startColumn, undefined);
  assert.equal(result.details.smartRead?.endColumn, undefined);
  assert.equal(result.details.truncation?.content, content.text);
});

test("multi-line normalization only names columnOffset when columnLimit is absent", async () => {
  const { dir, file } = await tempFile("mixed-offset.txt", Buffer.from("one\ntwo\nthree\n", "utf8"));
  const result = await smartRead(dir, {
    path: file,
    offset: 1,
    limit: 2,
    columnOffset: 99
  }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });
  const content = result.content[0];

  assert.equal(content?.type, "text");
  if (content?.type !== "text") return;
  assert.match(content.text, /^1 │ one\n2 │ two\n/);
  assert.match(content.text, /Warning: Ignored columnOffset=99 because column windows support only one line while limit=2 requests multiple lines\.$/);
  assert.doesNotMatch(content.text, /columnLimit/);
});

test("valid single-line column reads remain column windows", async () => {
  const { dir, file } = await tempFile("column-window.txt", Buffer.from("alpha\nbravo\ncharlie\n", "utf8"));
  const result = await smartRead(dir, {
    path: file,
    offset: 2,
    limit: 1,
    columnOffset: 2,
    columnLimit: 3
  }, { maxLines: 2000, maxBytes: 50_000, maxColumns: 400 });
  const content = result.content[0];

  assert.equal(content?.type, "text");
  if (content?.type !== "text") return;
  assert.match(content.text, /^2:2-4 │ rav\nShowing lines 2:2-4 of 3 \(truncated\)\./);
  assert.doesNotMatch(content.text, /Warning:/);
  assert.equal(result.details.smartRead?.startColumn, 2);
  assert.equal(result.details.smartRead?.endColumn, 4);
});
