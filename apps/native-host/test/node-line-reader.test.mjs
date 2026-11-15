import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createLineReader } from "../node/line-reader.mjs";

test("a timed-out line read loses nothing and a completed one returns the line", async () => {
  const stream = new PassThrough();
  const reader = createLineReader(stream);
  const timed = await reader.next(20);
  assert.equal(timed.kind, "timeout");
  stream.write("c3VjY2Vzcw==\n");
  const line = await reader.next(1000);
  assert.deepEqual(line, { kind: "line", line: "c3VjY2Vzcw==" });
  stream.end();
  assert.deepEqual(await reader.next(1000), { kind: "eof" });
  reader.close();
});

test("two sequential reads keep their order and a closed stream ends", async () => {
  const stream = new PassThrough();
  const reader = createLineReader(stream);
  stream.write("one\ntwo\n");
  assert.deepEqual(await reader.next(1000), { kind: "line", line: "one" });
  assert.deepEqual(await reader.next(1000), { kind: "line", line: "two" });
  stream.end();
  assert.deepEqual(await reader.next(1000), { kind: "eof" });
  reader.close();
});
