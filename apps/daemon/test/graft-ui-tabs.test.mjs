// Graft's own pages (home, chat) are listed and driven like web tabs, marked as Graft UI; Chrome's
// pages and other extensions' pages are not. `graft open` gets the chat tab's id back from the browser.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { BrowserInventoryFullSchema } from "@graft/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { BrowserInventoryRegistry } from "../dist/browser-inventory-registry.js";
import { drivableTab, listBrowserTabs } from "../dist/browser-control-values.js";

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const CHAT = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const CLIENT = "091b9308-1ee9-420e-b71f-a564a5a27701";
const RUN = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";

test("the daemon drives Graft's own pages and the web (not about:blank), never Chrome's or another extension's", () => {
  assert.equal(
    drivableTab({ url: `chrome-extension://${OWN}/chat.html?chatId=1`, graftUi: true }),
    true,
  );
  assert.equal(drivableTab({ url: "about:blank" }), false);
  assert.equal(drivableTab({ url: "https://example.com/" }), true);
  assert.equal(drivableTab({ url: `chrome-extension://${OTHER}/popup.html` }), false);
  assert.equal(drivableTab({ url: "chrome://settings" }), false);
});

test("browser.tabs() lists Graft's own pages with their ids, marked as Graft UI", () => {
  const tab = (tabId, url, extra = {}) => ({
    target: { clientInstanceId: CLIENT, browserRunId: RUN, tabId, tabIncarnation: RUN },
    url,
    title: url,
    ...extra,
  });
  const inventories = {
    get: () => ({
      tabs: [
        tab(1, "https://example.com/"),
        tab(2, `chrome-extension://${OWN}/chat.html?chatId=${CHAT}`, { graftUi: true }),
        tab(3, "chrome://newtab/"),
        tab(4, `chrome-extension://${OTHER}/popup.html`),
      ],
    }),
  };
  const executors = new Map([[CLIENT, { readyState: WebSocket.OPEN }]]);
  const { result } = listBrowserTabs({ op: "listTabs" }, executors, inventories);
  assert.deepEqual(
    result.tabs.map((listed) => listed.target.tabId),
    [1, 2],
  );
  assert.equal(result.tabs[1].graftUi, true);
  assert.equal("graftUi" in result.tabs[0], false);
});

test("graft open waits for the tab id the browser answers with, and reports the browser count", async () => {
  const harness = await createHarness();
  try {
    const opened = harness.service.openChatAndWait(CHAT, true);
    harness.service.handleChatOpened({ kind: "native.chat.opened", chatId: CHAT, tabId: 42 });
    assert.deepEqual(await opened, { browsers: 1, tabId: 42 });
    const nobody = await new BrowserControlService().openChatAndWait(CHAT, true);
    assert.deepEqual(nobody, { browsers: 0 });
  } finally {
    await harness.close();
  }
});

async function createHarness() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const service = new BrowserControlService();
  const inventory = new BrowserInventoryRegistry();
  service.useInventories(inventory);
  const ready = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const [socket] = await ready;
  await once(client, "open");
  inventory.applyFull(inventoryOf(CLIENT));
  service.connectExecutor(CLIENT, socket);
  return {
    service,
    close: async () => {
      client.close();
      socket.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function inventoryOf(clientInstanceId) {
  return BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    clientInstanceId,
    browserRunId: RUN,
    generation: 1,
    windows: [{ windowId: 4, focused: true, state: "normal", type: "normal" }],
    tabs: [],
  });
}
