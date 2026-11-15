import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import test from "node:test";
import { encodeFrame, readFrame, writeFrame, MAX_MESSAGE_BYTES } from "../node/frames.mjs";

test("native frames round trip and a clean EOF is not an error", async () => {
  const payload = Buffer.from('{"kind":"native.bootstrap"}', "utf8");
  const frame = encodeFrame(payload);
  assert.equal(frame.readInt32LE(0), payload.length);
  const stream = Readable.from([frame]);
  assert.deepEqual(await readFrame(stream), payload);
  assert.equal(await readFrame(Readable.from([])), null);
});

test("native frames reject empty, oversized and truncated messages", async () => {
  await assert.rejects(readFrame(Readable.from([Buffer.from([0, 0, 0, 0])])), /outside its bound/);
  const oversized = Buffer.alloc(4);
  oversized.writeInt32LE(MAX_MESSAGE_BYTES + 1, 0);
  await assert.rejects(readFrame(Readable.from([oversized])), /outside its bound/);
  const truncated = Buffer.concat([Buffer.from([5, 0, 0, 0]), Buffer.from("ab")]);
  await assert.rejects(readFrame(Readable.from([truncated])), /declared size/);
  assert.throws(() => encodeFrame(Buffer.alloc(0)), /outside its bound/);
});

test("writeFrame emits one header and body", async () => {
  const output = new PassThrough();
  const read = readFrame(output);
  await writeFrame(output, Buffer.from("hello"));
  assert.equal((await read).toString(), "hello");
});
