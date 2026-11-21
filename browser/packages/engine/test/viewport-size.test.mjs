// page.setViewportSize pins the tab's size through CDP. Chrome forgets the size when the debugger
// detaches, so a re-attach sends the agent's size again; a closed tab forgets it.
import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const removed = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (debuggee, method, params) => {
      calls.push({ debuggee, method, params });
      return {};
    },
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async (id) => ({ id, active: false, discarded: false, status: "complete" }),
    onRemoved: { addListener: (listener) => removed.push(listener) },
    onReplaced: { addListener() {} },
    onActivated: { addListener() {} },
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  storage: {
    session: { get: async () => ({}), set: async () => undefined },
    local: { get: async () => ({}) },
  },
  downloads: { onCreated: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
  scripting: { executeScript: async () => [] },
  windows: { get: async () => ({ focused: true, state: "normal" }) },
};

const session = await import("../dist/native-browser-session.js");
const { browserSurfaceApi } = await import("../dist/code-api-surface.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
try {
  // The worker registers the tab listeners here; parts this stub leaves out may throw, and that is fine.
  installEngineListeners();
} catch {
  // Each installer runs even when another one throws, so the session's listeners are in place.
}

const SIZE = { width: 420, height: 860, deviceScaleFactor: 0, mobile: false };
const sizeCalls = () =>
  calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride");

test("a re-attach puts back the size the agent set, and a cleared size is not sent again", async () => {
  session.noteDeviceEmulation(41, "Emulation.setDeviceMetricsOverride", SIZE);
  await session.reapplyDeviceEmulation(41);
  assert.equal(sizeCalls().length, 1);
  assert.deepEqual(sizeCalls()[0].params, SIZE);
  assert.deepEqual(sizeCalls()[0].debuggee, { tabId: 41 });
  session.noteDeviceEmulation(41, "Emulation.clearDeviceMetricsOverride", {});
  calls.length = 0;
  await session.reapplyDeviceEmulation(41);
  assert.equal(calls.length, 0);
});

test("a tab the agent never resized gets no size on attach", async () => {
  await session.reapplyDeviceEmulation(42);
  assert.equal(calls.length, 0);
});

test("a closed tab forgets its size", async () => {
  session.noteDeviceEmulation(43, "Emulation.setDeviceMetricsOverride", SIZE);
  for (const listener of removed) listener(43);
  await session.reapplyDeviceEmulation(43);
  assert.equal(calls.length, 0);
});

test("page.setViewportSize is a page method that pins the size through CDP", () => {
  assert.match(browserSurfaceApi, /setViewportSize: async \(size = \{\}\) => \{/);
  assert.match(
    browserSurfaceApi,
    /page\.cdp\('Emulation\.setDeviceMetricsOverride', \{ width, height, deviceScaleFactor: 0, mobile: false \}\)/,
  );
});
