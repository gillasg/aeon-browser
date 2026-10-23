import assert from "node:assert/strict";
import test from "node:test";
import { readToolImage } from "../dist/session-image.js";

test("image retrieval only reads the selected Pi branch and requested image index", () => {
  const content = [
    { type: "text", text: "Observation" },
    { type: "image", mimeType: "image/png", data: "AQID" },
  ];
  const entry = { type: "message", message: { role: "toolResult", toolCallId: "call-1", content } };
  const branch = [entry];
  const manager = { getBranch: () => [...branch] };
  const image = readToolImage(manager, "call-1", 0);
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual([...image.bytes], [1, 2, 3]);
  assert.throws(() => readToolImage(manager, "other-thread-call", 0), /current branch/);
  assert.throws(() => readToolImage(manager, "call-1", 1), /unavailable/);
  content[1].data = "A".repeat(5_592_409);
  assert.throws(() => readToolImage(manager, "call-1", 0), /oversized/);
});
