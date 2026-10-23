import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { BrowserControlService } from "../dist/browser-control-service.js";
const target = {
  clientInstanceId: randomUUID(),
  browserRunId: randomUUID(),
  tabId: 1,
  tabIncarnation: randomUUID(),
};
const url = "https://example.test/";
test("new runtime operations fail immediately on an older extension instead of timing out", async () => {
  const service = new BrowserControlService();
  service.useInventories({ findTarget: () => ({ target, url, documentEpoch: 1 }) });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = () => assert.fail("An old extension cannot execute runtime commands");
  service.connectExecutor(target.clientInstanceId, socket, false, true);
  const chatId = randomUUID();
  service.attachContext(chatId, target, url);
  for (const step of [
    { op: "evaluate", target, expression: "document.title" },
    {
      op: "click",
      target,
      element: { kind: "backend", backendNodeId: 1, documentEpoch: 1 },
      observe: false,
    },
  ]) {
    const result = JSON.parse(await service.execute(chatId, "upgrade", { steps: [step] }));
    assert.equal(result.steps[0].code, "UNSUPPORTED");
    assert.match(result.steps[0].detail, /Reload Aeon/);
  }
});
test("old browser executors reject new commands immediately with update guidance", async () => {
  const service = new BrowserControlService();
  service.useInventories({ findTarget: () => ({ target, url, documentEpoch: 1 }) });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = () => assert.fail("Do not send an unsupported request");
  service.connectExecutor(target.clientInstanceId, socket);
  const chatId = randomUUID();
  assert.equal(service.attachContext(chatId, target, url), "attached");
  const result = JSON.parse(
    await service.execute(chatId, "old-executor", {
      steps: [
        {
          op: "press",
          target,
          element: { kind: "locator", role: "combobox", name: "Search" },
          key: "Enter",
        },
      ],
    }),
  );
  assert.equal(result.steps[0].code, "UNSUPPORTED");
  assert.match(result.steps[0].detail, /Reload Aeon/);
});
test("new executor failures preserve specific action errors and their recovery detail", async () => {
  const service = new BrowserControlService();
  service.useInventories({ findTarget: () => ({ target, url, documentEpoch: 1 }) });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = (text) => {
    const request = JSON.parse(text);
    globalThis.queueMicrotask(() =>
      service.handleExecutorResult(
        {
          kind: "browser.operation.result",
          requestId: request.requestId,
          operationId: request.operationId,
          ok: false,
          code: "TARGET_NOT_FOUND",
          detail: "Use the Search combobox",
        },
        socket,
      ),
    );
  };
  service.connectExecutor(target.clientInstanceId, socket, false, true);
  const chatId = randomUUID();
  service.attachContext(chatId, target, url);
  const result = JSON.parse(
    await service.execute(chatId, "new-executor", {
      steps: [
        {
          op: "press",
          target,
          element: { kind: "locator", role: "combobox", name: "Search" },
          key: "Enter",
        },
      ],
    }),
  );
  assert.equal(result.steps[0].code, "TARGET_NOT_FOUND");
  assert.equal(result.steps[0].detail, "Use the Search combobox");
});
