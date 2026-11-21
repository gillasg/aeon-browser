import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { BrowserInventoryFullSchema } from "@aeon/protocol";
import { aeonBridge, inChat, sessionChatId } from "@aeon/pi-adapter";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { BrowserInventoryRegistry } from "../dist/browser-inventory-registry.js";
import { pinInherited } from "../dist/core-browsers.js";

// site_mapper and crawl run their browser code in a worker chat derived from the agent's chat.
// With two browsers connected, that worker must land where its parent works, not fail
// AMBIGUOUS_BROWSER because the derived chat id has no tabs of its own.
const browserA = "091b9308-1ee9-420e-b71f-a564a5a27701";
const browserB = "7c2f4b1e-0d5a-4e8b-9a61-3f2b8c9d0e14";
const runA = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";
const parent = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const url = "https://example.test/synthetic";

function tabOf(clientInstanceId) {
  return {
    clientInstanceId,
    browserRunId: runA,
    tabId: 19,
    tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
  };
}

function inventoryOf(clientInstanceId) {
  return BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    clientInstanceId,
    browserRunId: runA,
    generation: 1,
    windows: [{ windowId: 4, focused: true, state: "normal", type: "normal" }],
    tabs: [
      {
        target: tabOf(clientInstanceId),
        windowId: 4,
        index: 0,
        url,
        title: "Synthetic page",
        status: "complete",
        active: true,
        pinned: false,
        groupId: -1,
        documentEpoch: 4,
      },
    ],
  });
}

async function twoBrowsers() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const service = new BrowserControlService();
  const inventory = new BrowserInventoryRegistry();
  service.useInventories(inventory);
  const open = [];
  for (const id of [browserA, browserB]) {
    const ready = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const [socket] = await ready;
    await once(client, "open");
    inventory.applyFull(inventoryOf(id));
    // Both can run browser code, so an unpinned chat with no tabs is ambiguous.
    service.connectExecutor(id, socket, false, false, false, true);
    open.push(client, socket);
  }
  return {
    service,
    close: async () => {
      for (const item of open) item.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** What production wires as the browser tool: pin the worker like its parent, then run. */
function runner(service, seen) {
  return async (chatId, toolCallId, input) => {
    await pinInherited(service, "/nonexistent", chatId, inChatParent(), undefined);
    const info = JSON.parse(await service.execute(chatId, toolCallId, { browserInfo: true }));
    seen.push({ chatId, browsers: info.clientInstanceIds });
    return JSON.stringify({ value: input.codeCell.code });
  };
}

let currentParent;
function inChatParent() {
  return currentParent;
}

test("a worker chat of a parent bound to one browser runs there, not AMBIGUOUS_BROWSER", async () => {
  const harness = await twoBrowsers();
  try {
    assert.equal(harness.service.attachContext(parent, tabOf(browserA), url), "attached");
    assert.equal(harness.service.browserOf(parent), undefined, "two browsers, no pin");
    const seen = [];
    const bridge = aeonBridge(runner(harness.service, seen));
    currentParent = parent;
    await inChat(parent, () => bridge.run("1 + 1", { session: "site-to-api-map" }));
    assert.deepEqual(seen[0].browsers, [browserA]);
    assert.equal(seen[0].chatId, sessionChatId(parent, "site-to-api-map"));
  } finally {
    await harness.close();
  }
});

test("a parent pinned to a browser passes the pin to its crawl workers", async () => {
  const harness = await twoBrowsers();
  try {
    harness.service.pinChat(parent, browserB);
    const seen = [];
    const bridge = aeonBridge(runner(harness.service, seen));
    currentParent = parent;
    await inChat(parent, () => bridge.run("1", { session: "crawl-1" }));
    assert.deepEqual(seen[0].browsers, [browserB]);
  } finally {
    await harness.close();
  }
});

test("a parent with no browser of its own still has an ambiguous worker", async () => {
  const harness = await twoBrowsers();
  try {
    const seen = [];
    const bridge = aeonBridge(runner(harness.service, seen));
    currentParent = parent;
    await inChat(parent, () => bridge.run("1", { session: "crawl-1" }));
    assert.deepEqual(seen[0].browsers.sort(), [browserA, browserB].sort());
  } finally {
    await harness.close();
  }
});
