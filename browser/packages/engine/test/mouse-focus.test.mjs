// Every synthetic mouse event runs inside focus emulation. On macOS headless Chrome a move sent
// after a previous click turned focus emulation off is never answered (TAB_UNRESPONSIVE), so the
// landing move and page.mouse.* CDP calls must share the focus window with the press.
import assert from "node:assert/strict";
import test from "node:test";

const calls = [];

function payload(method) {
  if (method === "Page.getLayoutMetrics")
    return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
  if (method === "Runtime.evaluate") return { result: { objectId: "obj-1", value: "ok" } };
  return {};
}

function sink() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      calls.push({ method, params });
      return payload(method);
    },
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: sink(),
    onEvent: sink(),
  },
  tabs: {
    get: async (id) => ({
      id,
      active: false,
      discarded: false,
      status: "complete",
      url: "https://example.test/",
    }),
    onRemoved: sink(),
    onReplaced: sink(),
    onActivated: sink(),
    onUpdated: sink(),
    onCreated: sink(),
    onAttached: sink(),
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  storage: {
    session: { get: async () => ({}), set: async () => undefined },
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
  },
  downloads: { onCreated: sink() },
  runtime: {
    onInstalled: sink(),
    onStartup: sink(),
    onMessage: sink(),
    getURL: (path) => `chrome-extension://aeon/${path}`,
    sendMessage: async () => undefined,
  },
  scripting: { executeScript: async () => [] },
  alarms: { create() {}, onAlarm: sink() },
  windows: { get: async () => ({ focused: true, state: "normal" }) },
};

const { configureEngine, engineConfig } = await import("../dist/engine-config.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
const input = await import("../dist/native-browser-input.js");
const navigation = await import("../dist/native-browser-navigation.js");
const debuggerApi = await import("../dist/native-browser-debugger.js");

configureEngine({ hideAgentCursor: async () => true, agentGlow: async () => false });
engineConfig.cdpLimitFactor = 0.02;
installEngineListeners();

function target(tabId) {
  return {
    clientInstanceId: "00000000-0000-4000-8000-000000000001",
    browserRunId: "00000000-0000-4000-8000-000000000002",
    tabId,
    tabIncarnation: "00000000-0000-4000-8000-000000000003",
  };
}

/** The mouse call is bracketed by focus emulation, in this order. */
function focusedMouse() {
  const focus = calls
    .map((call, i) => ({ ...call, i }))
    .filter((call) => call.method === "Emulation.setFocusEmulationEnabled");
  const mouse = calls.findIndex((call) => call.method === "Input.dispatchMouseEvent");
  assert.ok(mouse >= 0, "a mouse event was sent");
  assert.ok(
    focus.some((call) => call.i < mouse && call.params?.enabled === true),
    "focus emulation is on before the mouse event",
  );
  assert.ok(
    focus.some((call) => call.i > mouse && call.params?.enabled === false),
    "focus emulation is off after the mouse event",
  );
}

test("a pointer gesture focuses the tab before its landing move", async () => {
  calls.length = 0;
  await input.executeInteraction(
    { tabId: 5100 },
    { op: "pointer", action: "hover", x: 27, y: 183, target: target(5100) },
  );
  const move = calls.findIndex((call) => call.method === "Input.dispatchMouseEvent");
  const focus = calls.findIndex(
    (call) => call.method === "Emulation.setFocusEmulationEnabled" && call.params?.enabled === true,
  );
  assert.ok(focus >= 0 && focus < move, "the move is inside the focus window");
  focusedMouse();
});

test("a page.mouse CDP call focuses the tab around the mouse event", async () => {
  calls.length = 0;
  await navigation.executePageCode(
    { tabId: 5101 },
    {
      step: {
        op: "cdp",
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 10, y: 20 },
        target: target(5101),
      },
    },
    async () => undefined,
  );
  focusedMouse();
});

test("a wheel scroll focuses the tab around the mouse event", async () => {
  calls.length = 0;
  await debuggerApi.scrollAt({ tabId: 5102 }, 40, 60, "down", 200);
  focusedMouse();
});
