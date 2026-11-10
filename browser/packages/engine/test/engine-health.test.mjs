import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_PROTOCOL_VERSION } from "@browserkit/protocol";
import { healthTurn } from "../dist/engine-health.js";
import { hostPlumbing } from "../dist/native-browser-host-plumbing.js";

test("the engine answers the health ping on a later turn, echoing the nonce", async () => {
  let settled = false;
  const pending = healthTurn({ nonce: "nonce-1" });
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  const result = await pending;
  assert.equal(settled, true);
  assert.equal(result.nonce, "nonce-1");
  assert.deepEqual(result.protocolVersion, ENGINE_PROTOCOL_VERSION);
});

test("host plumbing returns that engine answer on the executor socket", async () => {
  let sent;
  const socket = {
    send(text) {
      sent = JSON.parse(text);
    },
  };
  const handled = await hostPlumbing(
    { kind: "browser.host.health", action: "health", requestId: "req-1", nonce: "nonce-2" },
    socket,
  );
  assert.equal(handled, true);
  assert.equal(sent.kind, "browser.host.result");
  assert.equal(sent.requestId, "req-1");
  assert.equal(sent.ok, true);
  assert.equal(sent.result.nonce, "nonce-2");
  assert.deepEqual(sent.result.protocolVersion, ENGINE_PROTOCOL_VERSION);
});
