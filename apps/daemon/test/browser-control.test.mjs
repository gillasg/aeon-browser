import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { BrowserInventoryFullSchema, BrowserOperationResultSchema } from "@aeon/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { BrowserInventoryRegistry } from "../dist/browser-inventory-registry.js";

const clientInstanceId = "091b9308-1ee9-420e-b71f-a564a5a27701";
const browserRunId = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";
const chatId = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const otherChatId = "005cfe90-b334-4b04-bb8e-e50b091f2fe5";
const target = {
  clientInstanceId,
  browserRunId,
  tabId: 19,
  tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
};

test("browser control binds a borrowed target to one Chat and sends claimed work to its exact executor", async () => {
  const harness = await createHarness();
  try {
    const attached = await attachBorrowedTab(harness.service);
    assert.equal(attached.steps[0].disposition, "completed");
    assert.equal(attached.steps[0].result.tab.target.tabIncarnation, target.tabIncarnation);

    const { pending, request } = await startObserve(harness);
    assert.equal(request.kind, "browser.operation");
    assert.equal(request.toolCallId, "tool-observe");
    assert.equal(request.chatId, chatId);
    assert.equal(request.step.target.tabId, target.tabId);
    assert.equal(request.expectedDocumentEpoch, 4);
    assert.ok(request.claimId);
    assert.ok(request.claimGeneration > 0);
    const result = BrowserOperationResultSchema.parse({
      kind: "browser.operation.result",
      requestId: request.requestId,
      operationId: request.operationId,
      ok: true,
      result: {
        kind: "semantic",
        source: "website",
        trust: "untrusted",
        target,
        documentEpoch: 4,
        snapshotId: "3d1d98ec-631c-4beb-b2f8-534b38ce34ce",
        url: "https://example.test/synthetic",
        nodes: [],
        truncated: false,
      },
    });
    harness.client.send(JSON.stringify(result));
    const observed = JSON.parse(await pending);
    assert.equal(observed.steps[0].disposition, "completed");
    assert.equal(observed.steps[0].result.trust, "untrusted");

    const denied = JSON.parse(
      await harness.service.execute(otherChatId, "tool-other-chat", {
        steps: [{ op: "observe", target, kind: "semantic" }],
      }),
    );
    assert.equal(denied.steps[0].code, "TARGET_LOST");
  } finally {
    await harness.close();
  }
});

test("one exact tab can have two Chat context associations but only one live claim", async () => {
  const harness = await createHarness();
  try {
    await attachBorrowedTab(harness.service);
    const secondAssociation = JSON.parse(
      await harness.service.execute(otherChatId, "tool-attach-second", {
        steps: [{ op: "attachTab", target }],
      }),
    );
    assert.equal(secondAssociation.steps[0].disposition, "completed");

    const first = await startObserve(harness);
    const conflict = JSON.parse(
      await harness.service.execute(otherChatId, "tool-conflict", {
        steps: [{ op: "observe", target, kind: "semantic" }],
      }),
    );
    assert.equal(conflict.steps[0].code, "CLAIM_CONFLICT");

    harness.client.send(
      JSON.stringify({
        kind: "browser.operation.result",
        requestId: first.request.requestId,
        operationId: first.request.operationId,
        ok: true,
        result: {
          kind: "semantic",
          source: "website",
          trust: "untrusted",
          target,
          documentEpoch: 4,
          snapshotId: "3d1d98ec-631c-4beb-b2f8-534b38ce34ce",
          url: "https://example.test/synthetic",
          nodes: [],
          truncated: false,
        },
      }),
    );
    const firstResult = JSON.parse(await first.pending);
    assert.equal(firstResult.steps[0].disposition, "completed");
  } finally {
    await harness.close();
  }
});

test("context attaches require the captured URL and exact current tab identity", async () => {
  const harness = await createHarness();
  try {
    assert.equal(
      harness.service.attachContext(chatId, target, "https://example.test/synthetic"),
      "attached",
    );
    assert.equal(
      harness.service.attachContext(chatId, target, "https://example.test/another-page"),
      "stale",
    );
    const replacement = { ...target, tabIncarnation: "d750d891-8160-4abe-a3eb-cfcd3cc04c6c" };
    const tab = { ...createInventory().tabs[0], target: replacement };
    harness.inventory.applyFull({ ...createInventory(), generation: 2, tabs: [tab] });
    assert.equal(
      harness.service.attachContext(chatId, target, "https://example.test/synthetic"),
      "lost",
    );
    assert.equal(
      harness.service.attachContext(chatId, replacement, "https://example.test/synthetic"),
      "attached",
    );
  } finally {
    await harness.close();
  }
});

test("a lost target stays lost until a new reversible request opens a new tab", async () => {
  const harness = await createHarness();
  try {
    await attachBorrowedTab(harness.service);
    harness.inventory.applyFull({ ...createInventory(), generation: 2, tabs: [] });
    const lost = JSON.parse(
      await harness.service.execute(chatId, "tool-old-target", {
        steps: [{ op: "observe", target, kind: "semantic" }],
      }),
    );
    assert.equal(lost.steps[0].code, "TARGET_LOST");
    const reopenedTarget = await openSyntheticReplacement(harness);
    await observeSyntheticReplacement(harness, reopenedTarget);
  } finally {
    await harness.close();
  }
});

async function openSyntheticReplacement(harness) {
  const opening = harness.service.execute(chatId, "tool-reopen-reversible-work", {
    steps: [{ op: "openTab", clientInstanceId, url: "https://example.test/synthetic" }],
  });
  const request = JSON.parse((await nextMessage(harness.client)).toString());
  const reopenedTarget = { ...target, tabIncarnation: "d750d891-8160-4abe-a3eb-cfcd3cc04c6c" };
  const tab = createReplacementTab(reopenedTarget);
  harness.inventory.applyFull({ ...createInventory(), generation: 3, tabs: [tab] });
  harness.client.send(
    JSON.stringify({
      kind: "browser.operation.result",
      requestId: request.requestId,
      operationId: request.operationId,
      ok: true,
      result: { kind: "tab", tab },
    }),
  );
  const reopened = JSON.parse(await opening);
  assert.equal(reopened.steps[0].result.tab.target.tabIncarnation, reopenedTarget.tabIncarnation);
  return reopenedTarget;
}

function createReplacementTab(reopenedTarget) {
  return {
    target: reopenedTarget,
    windowId: 4,
    index: 0,
    url: "https://example.test/synthetic",
    title: "Synthetic page reopened",
    status: "complete",
    active: true,
    pinned: false,
    groupId: -1,
    documentEpoch: 0,
  };
}

async function observeSyntheticReplacement(harness, reopenedTarget) {
  const { pending, request } = await startObserve(harness, reopenedTarget);
  assert.equal(request.step.target.tabIncarnation, reopenedTarget.tabIncarnation);
  harness.client.send(
    JSON.stringify({
      kind: "browser.operation.result",
      requestId: request.requestId,
      operationId: request.operationId,
      ok: true,
      result: {
        kind: "semantic",
        source: "website",
        trust: "untrusted",
        target: reopenedTarget,
        documentEpoch: 0,
        snapshotId: "8f6ec9a8-b5b0-45af-8162-9fae1845f4a1",
        url: "https://example.test/synthetic",
        nodes: [],
        truncated: false,
      },
    }),
  );
  assert.equal(JSON.parse(await pending).steps[0].disposition, "completed");
}

async function createHarness() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const serverSocketReady = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const [serverSocket] = await serverSocketReady;
  await once(client, "open");
  const service = new BrowserControlService();
  const inventory = new BrowserInventoryRegistry();
  service.useInventories(inventory);
  serverSocket.on("message", (data) =>
    service.handleExecutorResult(JSON.parse(data.toString()), serverSocket),
  );
  inventory.applyFull(createInventory());
  service.connectExecutor(clientInstanceId, serverSocket);
  return {
    client,
    service,
    inventory,
    close: async () => {
      client.close();
      serverSocket.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createInventory() {
  const tab = {
    target,
    windowId: 4,
    index: 0,
    url: "https://example.test/synthetic",
    title: "Synthetic page",
    status: "complete",
    active: true,
    pinned: false,
    groupId: -1,
    documentEpoch: 4,
  };
  return BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    clientInstanceId,
    browserRunId,
    generation: 1,
    windows: [{ windowId: 4, focused: true, state: "normal", type: "normal" }],
    tabs: [tab],
  });
}

async function attachBorrowedTab(service) {
  return JSON.parse(
    await service.execute(chatId, "tool-attach", { steps: [{ op: "attachTab", target }] }),
  );
}

async function startObserve(harness, observeTarget = target) {
  const pending = harness.service.execute(chatId, "tool-observe", {
    steps: [{ op: "observe", target: observeTarget, kind: "semantic" }],
  });
  const request = JSON.parse((await nextMessage(harness.client)).toString());
  return { pending, request };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
}
