import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  CoreHealthResultSchema,
  ENGINE_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
} from "@aeon/protocol";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { HealthPings, isSupervisorHealthLine, supervisorHealthLine } from "../dist/health-ping.js";

test("a health reply counts only when the engine echoes this ping's nonce", async () => {
  const pings = new HealthPings();
  const echoed = await pings.ping((body) => {
    pings.handleReply({
      kind: "browser.host.result",
      requestId: body.requestId,
      ok: true,
      result: { nonce: body.nonce, protocolVersion: ENGINE_PROTOCOL_VERSION },
    });
    return true;
  });
  assert.equal(echoed.ok, true);
  assert.equal(echoed.daemon, true);
  assert.equal(echoed.extension, true);
  assert.equal(echoed.engine, true);
  assert.deepEqual(echoed.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(echoed.engineProtocol, ENGINE_PROTOCOL_VERSION);

  const wrong = await pings.ping((body) => {
    pings.handleReply({
      kind: "browser.host.result",
      requestId: body.requestId,
      ok: true,
      result: { nonce: "other", protocolVersion: ENGINE_PROTOCOL_VERSION },
    });
    return true;
  });
  assert.equal(wrong.extension, true);
  assert.equal(wrong.engine, false);
  assert.equal(wrong.ok, false);
});

test("no executor and a silent executor are not a healthy round trip", async () => {
  const pings = new HealthPings();
  const absent = await pings.ping(() => false, 20);
  assert.equal(absent.extension, false);
  assert.equal(absent.engine, false);
  const quiet = await pings.ping(() => true, 30);
  assert.equal(quiet.extension, false);
  assert.equal(pings.handleReply({ kind: "browser.operation" }), false);
});

test("the supervisor health line is the same report doctor reads", async () => {
  const request = Buffer.from(JSON.stringify({ kind: "supervisor.health" }), "utf8").toString(
    "base64",
  );
  assert.equal(isSupervisorHealthLine(request), true);
  assert.equal(isSupervisorHealthLine(Buffer.from("probe", "utf8").toString("base64")), false);
  const report = {
    ok: true,
    daemon: true,
    extension: true,
    engine: true,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    engineProtocol: ENGINE_PROTOCOL_VERSION,
    ms: 4,
  };
  const decoded = JSON.parse(Buffer.from(supervisorHealthLine(report), "base64").toString("utf8"));
  assert.equal(decoded.kind, "supervisor.health.result");
  const parsed = CoreHealthResultSchema.parse({
    kind: "core.health.result",
    requestId: randomUUID(),
    ...report,
  });
  assert.equal(parsed.engine, true);
});

test("pingHealth waits for the executor to answer as the engine", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const extension = new WebSocket(`ws://127.0.0.1:${port}`);
  const [daemonSide] = await once(server, "connection");
  await once(extension, "open");
  const service = new BrowserControlService();
  service.connectExecutor(randomUUID(), daemonSide);
  // The daemon sends on its socket; the extension is the side that receives it.
  extension.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.kind !== "browser.host.health") return;
    setTimeout(() => {
      service.handleHealthReply({
        kind: "browser.host.result",
        requestId: message.requestId,
        ok: true,
        result: { nonce: message.nonce, protocolVersion: ENGINE_PROTOCOL_VERSION },
      });
    }, 0);
  });
  try {
    const report = await service.pingHealth(1000);
    assert.equal(report.ok, true);
    assert.equal(report.engine, true);
    assert.deepEqual(report.engineProtocol, ENGINE_PROTOCOL_VERSION);
  } finally {
    extension.close();
    daemonSide.close();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("pingHealth fails closed when no browser is connected", async () => {
  const report = await new BrowserControlService().pingHealth(50);
  assert.equal(report.daemon, true);
  assert.equal(report.extension, false);
  assert.equal(report.ok, false);
});
