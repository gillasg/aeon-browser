import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { BrowserInventoryFullSchema } from "@aeon/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { BrowserInventoryRegistry } from "../dist/browser-inventory-registry.js";
import { findBrowser, renamed, sitesOf, summarize } from "../dist/core-browsers.js";

// aeon run --browser: a pinned chat opens and runs in its own Chrome profile only.
const main = "091b9308-1ee9-420e-b71f-a564a5a27701";
const evalBrowser = "7c2f4b1e-0d5a-4e8b-9a61-3f2b8c9d0e14";
const pinned = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const loose = "005cfe90-b334-4b04-bb8e-e50b091f2fe5";

test("a pinned chat's tab opens only in its browser; other chats still open everywhere", async () => {
  const harness = await createHarness([main, evalBrowser]);
  try {
    harness.service.pinChat(pinned, evalBrowser);
    const seen = { [main]: [], [evalBrowser]: [] };
    for (const [id, client] of harness.clients)
      client.on("message", (data) => seen[id].push(JSON.parse(data.toString())));
    assert.equal(harness.service.openChatTab(pinned), 1);
    assert.equal(harness.service.openChatTab(loose), 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = (id) =>
      seen[id].filter((m) => m.kind === "native.chat.open").map((m) => m.chatId);
    assert.deepEqual(opened(evalBrowser), [pinned, loose]);
    assert.deepEqual(opened(main), [loose]);

    const info = (chatId) =>
      harness.service
        .execute(chatId, "tool-info", { browserInfo: true })
        .then((text) => JSON.parse(text).clientInstanceIds.sort());
    assert.deepEqual(await info(pinned), [evalBrowser]);
    assert.deepEqual(await info(loose), [main, evalBrowser].sort());
  } finally {
    await harness.close();
  }
});

test("browsers are listed with their names and sites, and found by name or id prefix", async () => {
  const harness = await createHarness([main, evalBrowser]);
  try {
    const names = renamed({ [main]: "eval" }, evalBrowser, "eval");
    assert.deepEqual(names, { [evalBrowser]: "eval" }, "a name belongs to one browser");
    const list = summarize(harness.service, names);
    assert.equal(list.find((b) => b.clientInstanceId === evalBrowser).name, "eval");
    assert.deepEqual(list[0].sites, ["example.test"]);
    assert.equal(findBrowser(list, "eval").clientInstanceId, evalBrowser);
    assert.equal(findBrowser(list, "091b").clientInstanceId, main);
    assert.equal(findBrowser(list, "nope"), undefined);
    assert.deepEqual(renamed(names, evalBrowser, ""), {}, "an empty name clears it");
  } finally {
    await harness.close();
  }
});

test("sitesOf counts hosts, most tabs first, and skips non-web pages", () => {
  assert.deepEqual(
    sitesOf([
      "https://a.com/1",
      "chrome://newtab",
      "https://b.com",
      "https://a.com/2",
      "about:blank",
    ]),
    ["a.com", "b.com"],
  );
});

async function createHarness(ids) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const service = new BrowserControlService();
  const inventory = new BrowserInventoryRegistry();
  service.useInventories(inventory);
  const clients = new Map();
  const sockets = [];
  for (const id of ids) {
    const ready = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const [socket] = await ready;
    await once(client, "open");
    inventory.applyFull(inventoryOf(id));
    service.connectExecutor(id, socket);
    clients.set(id, client);
    sockets.push(socket);
  }
  return {
    service,
    clients,
    close: async () => {
      for (const client of clients.values()) client.close();
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function inventoryOf(clientInstanceId) {
  const browserRunId = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";
  return BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    clientInstanceId,
    browserRunId,
    generation: 1,
    windows: [{ windowId: 4, focused: true, state: "normal", type: "normal" }],
    tabs: [
      {
        target: {
          clientInstanceId,
          browserRunId,
          tabId: 19,
          tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
        },
        windowId: 4,
        index: 0,
        url: "https://example.test/synthetic",
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
