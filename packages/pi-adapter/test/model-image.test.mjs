import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";
import { decodePiInput } from "../dist/pi-input.js";

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** A real PNG whose long side is `width`. Solid black, so the file stays small. */
function widePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(row);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngSize(bytes) {
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    palette: bytes[25] === 3,
  };
}

test("a 4000 px capture arrives at 2048 and the saved file stays the original", async () => {
  const png = widePng(4000, 2);
  const original = Buffer.from(png);
  const data = png.toString("base64");
  const workspace = await mkdtemp(join(tmpdir(), "aeon-model-image-"));
  const artifact = join(workspace, "capture.png");
  await writeFile(artifact, png);
  try {
    const tool = createBrowserCodeTool("chat-1", async () =>
      JSON.stringify({
        output: "",
        steps: [
          {
            result: {
              kind: "screenshot",
              screenshotId: "wide",
              dataBase64: data,
              mimeType: "image/png",
              path: artifact,
            },
          },
        ],
      }),
    );
    const result = await tool.execute("call-1", { code: "x" }, undefined, undefined);
    const image = result.content.find((block) => block.type === "image");
    assert.ok(image, "the model receives the capture");
    const sized = pngSize(Buffer.from(image.data, "base64"));
    assert.ok(sized.width <= 2048 && sized.height <= 2048, `${sized.width}x${sized.height}`);
    assert.equal(sized.palette, false);
    assert.deepEqual(png, original);
    assert.deepEqual(await readFile(artifact), original);
    assert.equal(image.data === data, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a capture already within 2048 is sent unchanged", async () => {
  const png = widePng(32, 8);
  const data = png.toString("base64");
  const tool = createBrowserCodeTool("chat-1", async () =>
    JSON.stringify({
      output: "",
      steps: [
        {
          result: {
            kind: "screenshot",
            screenshotId: "s",
            dataBase64: data,
            mimeType: "image/png",
          },
        },
      ],
    }),
  );
  const result = await tool.execute("call-1", { code: "x" }, undefined, undefined);
  const image = result.content.find((block) => block.type === "image");
  assert.deepEqual(image, { type: "image", data, mimeType: "image/png" });
});

function palettePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from([255, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a GIF attachment becomes PNG and the attachment bytes stay a GIF", async () => {
  const gif = Buffer.from(
    "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b",
    "hex",
  );
  const original = Buffer.from(gif);
  const data = gif.toString("base64");
  const decoded = await decodePiInput({
    text: "What is in this image?",
    attachments: [{ name: "dot.gif", mimeType: "image/gif", data, byteLength: gif.length }],
  });
  assert.equal(decoded.images.length, 1);
  assert.equal(decoded.images[0].mimeType, "image/png");
  const sized = pngSize(Buffer.from(decoded.images[0].data, "base64"));
  assert.equal(sized.palette, false);
  assert.ok(sized.width <= 2048 && sized.height <= 2048);
  assert.deepEqual(gif, original);
  assert.equal(data, gif.toString("base64"));
});

test("a palette PNG attachment is re-encoded and the original bytes stay indexed", async () => {
  const png = palettePng();
  const original = Buffer.from(png);
  const data = png.toString("base64");
  const decoded = await decodePiInput({
    text: "What color is this?",
    attachments: [{ name: "swatch.png", mimeType: "image/png", data, byteLength: png.length }],
  });
  assert.equal(decoded.images.length, 1);
  assert.equal(decoded.images[0].mimeType, "image/png");
  assert.equal(pngSize(Buffer.from(decoded.images[0].data, "base64")).palette, false);
  assert.equal(decoded.images[0].data === data, false);
  assert.deepEqual(png, original);
  assert.equal(png[25], 3);
});
