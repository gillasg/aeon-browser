import assert from "node:assert/strict";
import test from "node:test";

const pending = [];
const calls = [];
const debuggerEvents = [];
let hangOn = () => false;
let frameTree = {};

function payload(method) {
  if (method === "Page.getLayoutMetrics")
    return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
  if (method === "Runtime.evaluate") return { result: { objectId: "obj-1", value: "ok" } };
  if (method === "Runtime.callFunctionOn")
    return {
      result: {
        value: {
          position: 0,
          extent: 1000,
          viewport: 400,
          visible: true,
          enabled: true,
          editable: true,
          x: 12,
          y: 24,
          hit: true,
        },
      },
    };
  if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };
  if (method === "DOM.describeNode") return { node: { backendNodeId: 5 } };
  if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
  if (method === "Page.getFrameTree") return frameTree;
  if (method === "DOM.getFrameOwner") return { backendNodeId: 9 };
  if (method === "DOM.getBoxModel")
    return {
      model: { content: [3, 4, 30, 4, 30, 20, 3, 20], border: [1, 2, 20, 2, 20, 16, 1, 16] },
    };
  if (method === "Accessibility.getFullAXTree")
    return {
      nodes: [
        {
          backendDOMNodeId: 5,
          ignored: false,
          role: { value: "textbox" },
          name: { value: "Note" },
        },
      ],
    };
  if (method === "Page.captureScreenshot") return { data: "img" };
  return {};
}

function sendCommand(_debuggee, method, params) {
  calls.push({ method, params });
  if (hangOn(method)) return new Promise((resolve) => pending.push(resolve));
  return Promise.resolve(payload(method));
}

function releasePending() {
  for (const resolve of pending.splice(0)) resolve({});
  hangOn = () => false;
}

function sink() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

globalThis.chrome = {
  debugger: {
    sendCommand,
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: sink(),
    onEvent: {
      addListener(fn) {
        debuggerEvents.push(fn);
      },
      removeListener() {},
    },
  },
  tabs: {
    get: async (id) => ({
      id,
      active: false,
      discarded: false,
      status: "complete",
      url: "https://example.test/",
    }),
    reload: async () => undefined,
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

const { callLimitMs, recent } = await import("../dist/cdp/send.js");
const { configureEngine, engineConfig } = await import("../dist/engine-config.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
const { bindBrowserSession } = await import("../dist/native-browser-session.js");
const scroll = await import("../dist/native-browser-scroll.js");
const input = await import("../dist/native-browser-input.js");
const human = await import("../dist/native-browser-human-input.js");
const dry = await import("../dist/native-browser-dry-run.js");
const cursor = await import("../dist/native-browser-cursor.js");
const observation = await import("../dist/native-browser-observation.js");

configureEngine({
  hideAgentCursor: async () => true,
  agentGlow: async () => false,
});
engineConfig.cdpLimitFactor = 0.02;
human.setHumanInputEnabled(false);
installEngineListeners();

const MARGIN = 2_500;
let tabSeq = 4_000;
const nextTab = () => tabSeq++;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function target(tabId) {
  return {
    clientInstanceId: "00000000-0000-4000-8000-000000000001",
    browserRunId: "00000000-0000-4000-8000-000000000002",
    tabId,
    tabIncarnation: "00000000-0000-4000-8000-000000000003",
  };
}

function failed(tabId, label) {
  return recent(tabId).some((row) => row.label === label && row.ok === false);
}

function nth(method, n) {
  let seen = 0;
  return (next) => {
    if (next !== method) return false;
    seen += 1;
    return seen === n;
  };
}

function withTree(run) {
  return {
    prepare() {
      frameTree = { frameTree: { frame: { id: "root" } } };
    },
    run,
  };
}

function own(run) {
  return (tabId) => {
    bindBrowserSession(tabId, "s2");
    return run(tabId);
  };
}

async function until(pred) {
  for (;;) {
    if (pred()) return;
    await pause(10);
  }
}

async function settled(run, limit, times = 1) {
  const cap = limit * times + MARGIN;
  const started = Date.now();
  const status = await Promise.race([
    run().then(
      () => "settled",
      () => "settled",
    ),
    pause(cap).then(() => "hung"),
  ]);
  assert.equal(status, "settled");
  assert.ok(Date.now() - started <= cap + 150);
}

function direct(name, method, run, extra = {}) {
  const evalMs = extra.eval === true;
  return {
    name,
    method,
    times: extra.times ?? 1,
    limit: () => (evalMs ? callLimitMs(method, 5_000) : callLimitMs(method)),
    hang: extra.hang ?? ((next) => next === method),
    prepare: extra.prepare,
    run,
    check(tabId) {
      assert.equal(failed(tabId, extra.label ?? name), true, `${name} ${method}`);
      if (!evalMs) return;
      assert.equal(
        calls.some((call) => call.method === method && call.params?.timeout === 5_000),
        true,
        `${name} timeout`,
      );
    },
  };
}

function resetHarness() {
  calls.length = 0;
  frameTree = {};
  human.setHumanInputEnabled(false);
  configureEngine({ hideAgentCursor: async () => true, agentGlow: async () => false });
}

async function runCase(item) {
  const tabId = nextTab();
  resetHarness();
  item.prepare?.();
  hangOn = item.hang;
  try {
    await settled(() => item.run(tabId), item.limit(), item.times);
    item.check(tabId);
  } finally {
    releasePending();
    await pause(0);
    resetHarness();
  }
}

function scrollCases() {
  const debuggee = (tabId) => ({ tabId });
  return [
    direct(
      "selectScrollContainer",
      "Runtime.evaluate",
      (tabId) => scroll.selectScrollContainer(debuggee(tabId), { x: 4, y: 5 }, false),
      { eval: true },
    ),
    direct(
      "measureScroll",
      "Runtime.callFunctionOn",
      (tabId) => scroll.measureScroll(debuggee(tabId), "obj-1", false),
      { eval: true },
    ),
    direct("scrollWithFeedback", "Runtime.releaseObject", (tabId) =>
      scroll.scrollWithFeedback(debuggee(tabId), {
        step: { op: "scroll", direction: "down", amount: 80, target: target(tabId) },
      }),
    ),
  ];
}

function pointerCases() {
  const step = (tabId, action) => ({ op: "pointer", action, x: 3, y: 4, target: target(tabId) });
  return [
    direct("actionablePoint", "DOM.scrollIntoViewIfNeeded", (tabId) =>
      input.actionablePoint({ tabId }, 5),
    ),
    direct("pressKey", "Input.dispatchKeyEvent", (tabId) => input.pressKey({ tabId }, "Enter")),
    direct("executeInteraction", "Input.dispatchMouseEvent", (tabId) =>
      input.executeInteraction({ tabId }, step(tabId, "hover")),
    ),
    direct("keyboard", "Input.dispatchKeyEvent", (tabId) =>
      input.executeInteraction({ tabId }, { op: "keys", keys: "Enter", target: target(tabId) }),
    ),
  ];
}

function humanCases() {
  const typing = (text) => ({
    prepare() {
      human.setHumanInputEnabled(true);
    },
    run: (tabId) => human.humanType({ tabId }, text),
  });
  return [
    direct("humanType", "Input.insertText", (tabId) => human.humanType({ tabId }, "hi")),
    direct(
      "humanType",
      "Input.dispatchKeyEvent",
      typing("a".repeat(121)).run,
      typing("a".repeat(121)),
    ),
    direct("humanType", "Input.insertText", typing("é").run, typing("é")),
    direct("humanType", "Input.dispatchKeyEvent", typing("a").run, typing("a")),
    direct("humanType", "Input.dispatchKeyEvent", typing("a").run, {
      ...typing("a"),
      hang: nth("Input.dispatchKeyEvent", 2),
    }),
    direct(
      "dispatch",
      "Input.dispatchMouseEvent",
      (tabId) => human.humanMouse({ tabId }, "mouseWheel", { x: 1, y: 1, deltaX: 0, deltaY: 200 }),
      {
        prepare() {
          human.setHumanInputEnabled(true);
        },
      },
    ),
  ];
}

function frameCases() {
  const at = (frameId, selector) => (tabId) => input.interactFrame({ tabId }, frameId, selector);
  return [
    direct("resolveFrameObject", "DOM.resolveNode", at("root", 5)),
    direct("resolveFrameObject", "Runtime.evaluate", at("root", "#go"), { eval: true }),
    direct("interactFrame", "DOM.describeNode", at("root", "#go")),
    direct("frameOffset", "DOM.getFrameOwner", at("child", "#go"), withTree(at("child", "#go"))),
    direct("frameOffset", "DOM.getBoxModel", at("child", "#go"), {
      ...withTree(at("child", "#go")),
      hang: nth("DOM.getBoxModel", 1),
    }),
    direct("interactFrame", "Runtime.releaseObject", at("root", "#go"), {
      ...withTree(at("root", "#go")),
      hang: nth("Runtime.releaseObject", 2),
    }),
  ];
}

function dryCases() {
  return [
    direct(
      "setDryRun",
      "Fetch.enable",
      own((tabId) => dry.setDryRun(tabId, true)),
    ),
    direct(
      "setDryRun",
      "Fetch.disable",
      own(async (tabId) => {
        await dry.setDryRun(tabId, true);
        await dry.setDryRun(tabId, false);
      }),
    ),
    direct(
      "answer",
      "Fetch.fulfillRequest",
      own(async (tabId) => {
        await dry.setDryRun(tabId, true);
        paused(tabId, "POST", "https://example.test/like");
        await until(() => failed(tabId, "answer"));
      }),
    ),
    direct(
      "answer",
      "Fetch.continueRequest",
      own(async (tabId) => {
        await dry.setDryRun(tabId, true);
        paused(tabId, "GET", "https://example.test/search");
        await until(() => failed(tabId, "answer"));
      }),
    ),
  ];
}

function paused(tabId, method, url) {
  const params = { requestId: "req-1", request: { method, url } };
  for (const listener of debuggerEvents) listener({ tabId }, "Fetch.requestPaused", params);
}

function cursorCases() {
  return [
    direct(
      "updateAgentCursor",
      "Runtime.evaluate",
      async (tabId) => {
        cursor.showAgentCursor({ tabId }, 8, 9, false);
        await until(() => failed(tabId, "updateAgentCursor"));
      },
      {
        eval: true,
        prepare() {
          configureEngine({ hideAgentCursor: async () => false, agentGlow: async () => false });
        },
      },
    ),
  ];
}

function pasteRequest(tabId) {
  return {
    expectedDocumentEpoch: 1,
    step: {
      op: "paste",
      text: "hello",
      html: "<b>hello</b>",
      target: target(tabId),
      element: { kind: "backend", backendNodeId: 5, documentEpoch: 1 },
    },
  };
}

function pasteCases() {
  const paste = (tabId) => input.performAction(pasteRequest(tabId), async () => undefined);
  return [
    direct("pasteNode", "Page.bringToFront", own(paste)),
    direct("pageClipboard", "Runtime.evaluate", own(paste), {
      eval: true,
      hang: nth("Runtime.evaluate", 2),
    }),
    direct("pasteNode", "Input.dispatchKeyEvent", own(paste)),
  ];
}

async function clickPoint(tabId) {
  bindBrowserSession(tabId, "s2");
  const shot = await observation.captureScreenshot(
    {
      expectedDocumentEpoch: 1,
      step: { op: "scroll", direction: "down", amount: 10, target: target(tabId) },
    },
    { id: tabId, url: "https://example.test/" },
    async () => undefined,
  );
  await input.clickScreenshotPoint(
    { tabId },
    {
      expectedDocumentEpoch: 1,
      step: {
        op: "click",
        target: target(tabId),
        element: { kind: "point", screenshotId: shot.screenshotId, x: 0.5, y: 0.5 },
      },
    },
  );
}

function shotCases() {
  return [
    direct("clickScreenshotPoint", "Page.getLayoutMetrics", clickPoint, {
      hang: nth("Page.getLayoutMetrics", 2),
    }),
  ];
}

function allCases() {
  return [
    ...scrollCases(),
    ...pointerCases(),
    ...humanCases(),
    ...frameCases(),
    ...dryCases(),
    ...cursorCases(),
    ...pasteCases(),
    ...shotCases(),
  ];
}

test("S2 call sites settle when one CDP method never answers", async (t) => {
  for (const item of allCases()) await t.test(`${item.name} ${item.method}`, () => runCase(item));
});
