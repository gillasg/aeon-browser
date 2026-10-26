import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { CdpService } from "../dist/cdp-service.js";

// The shared CdpServer is covered by browserkit's real Playwright test. This daemon test proves
// the daemon adapter: a raw CDP client opens a tab, attaches, runs a page command and closes it,
// with every hop using the executor messages the extension already answers.
test("the daemon CDP adapter round-trips targets, sessions and commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-cdp-"));
  const sent = [];
  const service = new CdpService((body) => {
    sent.push(body);
    if (body.kind === "cdp.newTab") {
      setTimeout(() =>
        service.handle({
          kind: "cdp.tab",
          id: body.id,
          targetId: "target-1",
          tab: { tabId: 7, url: body.url, title: "", target: { tabId: 7 } },
        }),
      );
    } else if (body.kind === "cdp.command") {
      setTimeout(() =>
        service.handle({
          kind: "cdp.result",
          id: body.id,
          result: { result: { type: "number", value: 2 } },
        }),
      );
    } else if (body.kind === "cdp.closeTab") {
      setTimeout(() => service.handle({ kind: "cdp.tab", id: body.id, closed: true }));
    }
  }, directory);
  const info = await service.start(0);
  try {
    const version = await fetch(`${info.url}/json/version?token=${info.token}`);
    assert.equal(version.status, 200);
    assert.match(String((await version.json()).webSocketDebuggerUrl), /token=/);

    const socket = new WebSocket(info.wsUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const waiters = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      waiters.get(message.id)?.(message);
    });
    const call = (id, method, params, sessionId) =>
      new Promise((resolve) => {
        waiters.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    await call(1, "Target.setDiscoverTargets", { discover: true });
    const created = await call(2, "Target.createTarget", { url: "https://example.com" });
    assert.equal(created.result.targetId, "target-1");
    const attached = await call(3, "Target.attachToTarget", {
      targetId: "target-1",
      flatten: true,
    });
    const evaluated = await call(
      4,
      "Runtime.evaluate",
      { expression: "1 + 1", returnByValue: true },
      attached.result.sessionId,
    );
    assert.equal(evaluated.result.result.value, 2);
    const closed = await call(5, "Target.closeTarget", { targetId: "target-1" });
    assert.equal(closed.result.success, true);
    assert.ok(
      sent.some((body) => body.kind === "cdp.command" && body.method === "Runtime.evaluate"),
    );
    assert.ok(sent.some((body) => body.kind === "cdp.closeTab" && body.tabId === 7));
    socket.close();
  } finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
