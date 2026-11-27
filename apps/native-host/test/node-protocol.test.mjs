import assert from "node:assert/strict";
import test from "node:test";
import {
  failure,
  isAliveAnswer,
  isBase64,
  isStopRequest,
  matchesOrigin,
  phaseOf,
  readEnvelope,
  restartDelay,
} from "../node/protocol.mjs";
import { ORIGIN, EXTENSION_ID } from "./node-helpers.mjs";

const extensionId = EXTENSION_ID;

test("only the configured extension origin is allowed", () => {
  assert.equal(matchesOrigin(ORIGIN, ORIGIN), true);
  assert.equal(matchesOrigin(ORIGIN + "/", ORIGIN), true);
  for (const origin of [
    `chrome-extension://${extensionId}/?x=1`,
    `chrome-extension://${extensionId}/#x`,
    `chrome-extension://user@${extensionId}`,
    `https://${extensionId}`,
    "chrome-extension://" + "b".repeat(32),
    "not a url",
  ])
    assert.equal(matchesOrigin(origin, ORIGIN), false, origin);
});

test("bootstrap envelopes carry exactly three keys, the right origin and bounded bytes", () => {
  const request = Buffer.from('{"kind":"native.bootstrap"}');
  const envelope = {
    kind: "supervisor.bootstrap",
    origin: ORIGIN,
    requestBase64: request.toString("base64"),
  };
  assert.deepEqual(readEnvelope(envelope, ORIGIN), request);
  assert.equal(readEnvelope({ ...envelope, extra: 1 }, ORIGIN), "ORIGIN_NOT_ALLOWED");
  assert.equal(
    readEnvelope({ ...envelope, origin: "chrome-extension://" + "b".repeat(32) }, ORIGIN),
    "ORIGIN_NOT_ALLOWED",
  );
  assert.equal(readEnvelope({ ...envelope, requestBase64: "***" }, ORIGIN), "INVALID_REQUEST");
  assert.equal(readEnvelope({ ...envelope, requestBase64: "" }, ORIGIN), "INVALID_REQUEST");
  assert.equal(
    readEnvelope({ ...envelope, requestBase64: Buffer.alloc(16385).toString("base64") }, ORIGIN),
    "INVALID_REQUEST",
  );
});

test("stop requests, health lines and progress markers are recognized", () => {
  assert.equal(isStopRequest({ kind: "supervisor.stop" }), true);
  assert.equal(isStopRequest({ kind: "supervisor.stop", extra: 1 }), false);
  assert.equal(isStopRequest({ kind: "supervisor.health" }), false);
  assert.equal(phaseOf("GRAFT_DAEMON_PHASE runtime"), "runtime");
  assert.equal(phaseOf("GRAFT_DAEMON_READY"), undefined);
  assert.equal(isBase64(Buffer.from("x").toString("base64")), true);
  assert.equal(isBase64("not base64"), false);
  const health = Buffer.from('{"kind":"supervisor.health.result"}').toString("base64");
  assert.equal(isAliveAnswer(health), true);
  const unavailable = Buffer.from('{"code":"BOOTSTRAP_UNAVAILABLE"}').toString("base64");
  assert.equal(isAliveAnswer(unavailable), true);
  assert.equal(isAliveAnswer(Buffer.from("nope").toString("base64")), false);
});

test("restart backoff is 1 s after a crash and backs off to 30 s", () => {
  assert.equal(restartDelay(0), 1000);
  assert.equal(restartDelay(1), 1000);
  assert.equal(restartDelay(2), 2000);
  assert.equal(restartDelay(3), 4000);
  assert.equal(restartDelay(10), 30000);
});

test("failures name the code and retryability", () => {
  const parsed = JSON.parse(failure("DAEMON_OFFLINE", true).toString("utf8"));
  assert.equal(parsed.kind, "native.bootstrap.result");
  assert.equal(parsed.code, "DAEMON_OFFLINE");
  assert.equal(parsed.retryable, true);
  assert.deepEqual(parsed.supportedProtocolVersion, { major: 1, minor: 1 });
});
