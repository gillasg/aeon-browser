import assert from "node:assert/strict";
import test from "node:test";

// A demo that opens a second tab mid-run binds that tab to the chat. Recording follows the bind,
// not only the first debugger attach.

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    session: { get: async () => ({}), set: async () => undefined },
  },
  tabs: {
    get: async (id) => ({ id, url: "https://demo.test/", title: "Demo" }),
    sendMessage: async () => undefined,
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onReplaced: { addListener() {} },
    onActivated: { addListener() {} },
    onCreated: { addListener() {} },
  },
  windows: { getLastFocused: async () => undefined, onCreated: { addListener() {} } },
  debugger: {
    attach: async () => undefined,
    detach: async () => undefined,
    sendCommand: async () => undefined,
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  runtime: {
    onStartup: { addListener() {} },
    sendMessage: async (message) =>
      message?.kind === "ping" ? { ok: true } : { ok: false, error: "no encoder in test" },
  },
  offscreen: {
    hasDocument: async () => true,
    Reason: { WORKERS: "WORKERS", USER_MEDIA: "USER_MEDIA" },
  },
  tabCapture: {
    getMediaStreamId: async () => {
      throw new Error("no tab capture");
    },
  },
  scripting: { executeScript: async () => undefined },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabGroups: { TAB_GROUP_ID_NONE: -1 },
};

const { engineConfig } = await import("../dist/engine-config.js");
const { bindBrowserSession } = await import("../dist/native-browser-session.js");
const { takeTabs } = await import("../dist/native-browser-recording.js");
const { followBoundTabs } = await import("../dist/native-browser-takes.js");

engineConfig.recordAgentTabs = async () => true;
engineConfig.hideAgentCursor = async () => true;
followBoundTabs();

async function untilFollowed(ids) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (ids.every((id) => takeTabs.has(id))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("binding a second tab mid-run records it too", async () => {
  takeTabs.delete(31);
  takeTabs.delete(32);
  bindBrowserSession(31, "demo");
  bindBrowserSession(32, "demo");
  await untilFollowed([31, 32]);
  assert.equal(takeTabs.get(31)?.chatId, "demo");
  assert.equal(takeTabs.get(32)?.chatId, "demo");
  assert.notEqual(takeTabs.get(31)?.url, undefined);
});
