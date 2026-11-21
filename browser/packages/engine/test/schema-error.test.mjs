import assert from "node:assert/strict";
import test from "node:test";
import { clampTimeoutMs, readableSchemaError } from "@browserkit/protocol";

const ZOD_TIMEOUT = `[
  { "origin": "number", "code": "too_small", "minimum": 1000, "inclusive": true, "path": ["timeoutMs"], "message": "Too small: expected number to be >=1000" }
]`;

test("a zod timeout issue is one INVALID_INPUT line naming the field and the range", () => {
  assert.equal(
    readableSchemaError(ZOD_TIMEOUT),
    "INVALID_INPUT: timeoutMs must be an integer from 1000 to 600000",
  );
  assert.equal(readableSchemaError("CODE_ERROR: nope"), undefined);
  assert.equal(
    readableSchemaError(
      '[{"code":"too_small","minimum":1,"path":["limit"],"message":"too small"}]',
    ),
    "INVALID_INPUT: limit must be >= 1",
  );
});

test("a cell timeout below 1000 ms is raised to the minimum, and zero stays spent", () => {
  assert.deepEqual(clampTimeoutMs(500), {
    timeoutMs: 1000,
    warn: "[warn] timeoutMs raised to 1000 (minimum)",
  });
  assert.deepEqual(clampTimeoutMs(0), { timeoutMs: 0 });
  assert.deepEqual(clampTimeoutMs(1000), { timeoutMs: 1000 });
  assert.equal(clampTimeoutMs(60_000).warn, undefined);
});
