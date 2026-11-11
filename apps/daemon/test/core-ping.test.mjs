import assert from "node:assert/strict";
import test from "node:test";
import { CorePingResultSchema } from "@aeon/protocol";
import { handleCorePing } from "../src/core-health.ts";

test("core.ping is answered on this turn, without the extension", () => {
  const sent = [];
  const socket = { readyState: 1, send: (body) => sent.push(body) };
  const requestId = "11111111-1111-4111-8111-111111111111";
  assert.equal(handleCorePing(socket, { kind: "core.ping", requestId }), true);
  assert.equal(sent.length, 1);
  assert.equal(CorePingResultSchema.parse(JSON.parse(sent[0])).requestId, requestId);
  assert.equal(handleCorePing(socket, { kind: "core.health", requestId }), false);
});
