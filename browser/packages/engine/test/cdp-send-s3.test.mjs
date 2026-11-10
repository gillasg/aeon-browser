// DOM, frames, observation and preview: a fake debuggee that never answers one method.
// Each call path must settle within its limit, and eval calls must pass ms through as timeout.

import assert from "node:assert/strict";
import { test } from "node:test";

const pending = [];
const calls = [];
const events = [];
let hangOn = () => false;
let previewDone = false;
let previewResolve = () => undefined;

function sendCommand(debuggee, method, params) {
  calls.push({ method, debuggee, params });
  if (hangOn(method, params, debuggee)) return new Promise((resolve) => pending.push(resolve));
  return Promise.resolve(payload(method, params));
}

function bag() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

// Listeners from modules this import graph pulls in only need to register. Missing Chrome APIs
// become no-op functions so installEngineListeners can reach the frame listener.
function stub(target) {
  return new Proxy(target, {
    get(current, prop) {
      if (typeof prop === "symbol" || prop in current) return current[prop];
      const child = callable();
      current[prop] = child;
      return child;
    },
  });
}

function callable() {
  const fn = () => undefined;
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === "addListener" || prop === "removeListener") return () => undefined;
      if (prop === "hasListener") return () => false;
      if (typeof prop === "symbol" || prop in target) return target[prop];
      const child = callable();
      target[prop] = child;
      return child;
    },
  });
}

globalThis.chrome = stub({
  debugger: stub({
    sendCommand,
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: bag(),
    onEvent: {
      addListener(fn) {
        events.push(fn);
      },
      removeListener() {},
    },
  }),
  tabs: stub({
    get: async (id) =>
      previewDone
        ? undefined
        : { id, active: false, discarded: false, status: "complete", url: "https://example.test/" },
    reload: async () => undefined,
    onRemoved: bag(),
    onReplaced: bag(),
    onActivated: bag(),
    onUpdated: bag(),
  }),
  action: stub({
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  }),
  storage: stub({
    session: { get: async () => ({}), set: async () => undefined },
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
  }),
  runtime: stub({
    id: "test",
    sendMessage: async (message) => {
      if (message?.kind !== "aeon.browser.preview") return;
      previewDone = true;
      previewResolve();
    },
    onInstalled: bag(),
    onStartup: bag(),
    getURL: (path) => path,
  }),
  scripting: stub({ executeScript: async () => [] }),
  windows: stub({ get: async () => ({ focused: true, state: "normal" }) }),
  downloads: stub({ onCreated: bag() }),
});

const { callLimitMs, recent } = await import("../dist/cdp/send.js");
const { configureEngine, engineConfig } = await import("../dist/engine-config.js");
const { setHumanInputEnabled } = await import("../dist/native-browser-human-input.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
const session = await import("../dist/native-browser-session.js");
const dom = await import("../dist/native-browser-dom.js");
const frames = await import("../dist/native-browser-frames.js");
const observation = await import("../dist/native-browser-observation.js");
const preview = await import("../dist/native-browser-preview.js");

configureEngine({
  agentGlow: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(true),
  agentView: () => Promise.resolve("split"),
});
setHumanInputEnabled(false);
engineConfig.cdpLimitFactor = 0.02;
installEngineListeners();

const MARGIN = 2_500;
let tabSeq = 5_000;
const nextTab = () => tabSeq++;
const at = (tabId) => ({ tabId });

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releasePending() {
  for (const resolve of pending.splice(0)) resolve({});
  hangOn = () => false;
}

function payload(method, params) {
  return evalPayload(method, params) ?? readPayload(method, params) ?? {};
}

function evalPayload(method, params) {
  if (method !== "Runtime.evaluate" && method !== "Runtime.callFunctionOn") return undefined;
  const text = String(params?.functionDeclaration ?? params?.expression ?? "");
  return pageResult(text) ?? groupResult(method, params) ?? { result: { value: true } };
}

function pageResult(text) {
  if (text.includes("layoutProbe")) return { result: { value: "fp" } };
  if (text.includes("this.type")) return fileState();
  if (text.includes("this.files")) return { result: { value: [] } };
  if (text.includes("type==='file'")) return { result: { objectId: "file" } };
  return undefined;
}

function groupResult(method, params) {
  const group = String(params?.objectGroup ?? "");
  if (method === "Runtime.callFunctionOn" && group.startsWith("aeon-fill"))
    return { result: { objectId: "selected" } };
  if (group) return { result: { objectId: "list" } };
  return undefined;
}

function fileState() {
  return { result: { value: { type: "file", multiple: true, disabled: false } } };
}

function readPayload(method, params) {
  if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
  if (method === "Runtime.getProperties")
    return { result: [{ name: "0", value: { objectId: "el0" } }] };
  if (method === "DOM.describeNode") return described(params);
  if (method === "Page.getFrameTree") return frameTree();
  if (method === "Page.createIsolatedWorld") return { executionContextId: 3 };
  if (method === "DOM.getFrameOwner") return { backendNodeId: 9 };
  if (method === "DOM.getBoxModel") return { model: { content: [4, 6, 24, 6, 24, 30, 4, 30] } };
  if (method === "Accessibility.getFullAXTree") return { nodes: [] };
  if (method === "Page.getLayoutMetrics") return layout();
  if (method === "Page.captureScreenshot") return { data: "abc" };
  return undefined;
}

function described(params) {
  if (params?.depth === -1) return { node: { backendNodeId: params.backendNodeId ?? 7 } };
  return { node: { backendNodeId: 42, frameId: "root" } };
}

function frameTree() {
  return {
    frameTree: {
      frame: { id: "root", url: "https://example.test/", loaderId: "l1" },
      childFrames: [{ frame: { id: "child", url: "https://example.test/child", loaderId: "l2" } }],
    },
  };
}

function layout() {
  return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
}

function fault(name, method, run, extra = {}) {
  return {
    name,
    method,
    run,
    ms: extra.ms,
    label: extra.label ?? name,
    hang: extra.hang ?? ((next) => next === method),
    limit: () => callLimitMs(method, extra.ms),
  };
}

test("S3 call sites settle when one CDP method never answers", async () => {
  for (const item of cases()) await one(item);
});

async function one(item) {
  calls.length = 0;
  hangOn = item.hang;
  const tabId = nextTab();
  try {
    await settled(item, tabId);
    assertSent(item);
  } finally {
    releasePending();
    await pause(0);
  }
}

async function settled(item, tabId) {
  const cap = item.limit() + MARGIN;
  const started = Date.now();
  const status = await Promise.race([
    item.run(tabId).then(
      () => "settled",
      () => "settled",
    ),
    pause(cap).then(() => "hung"),
  ]);
  assert.equal(status, "settled", `${item.name} ${item.method} hung`);
  assert.ok(Date.now() - started <= cap + 100, `${item.name} ${item.method} overran`);
}

function assertSent(item) {
  const call = calls.find((entry) => item.hang(entry.method, entry.params, entry.debuggee));
  assert.ok(call, `${item.name} never sent ${item.method}`);
  const row = recent(call.debuggee.tabId).find(
    (entry) => entry.label === item.label && entry.method === item.method,
  );
  assert.ok(row, `${item.name} was not recorded as ${item.label}`);
  if (item.ms !== undefined) assert.equal(call.params.timeout, item.ms);
}

function cases() {
  return [...nodeCases(), ...queryCases(), ...fillCases(), ...frameCases(), ...observeCases()];
}

function nodeCases() {
  return [
    fault("onNode", "DOM.resolveNode", (tabId) => dom.onNode(at(tabId), 1, () => 1)),
    fault("onNode", "Runtime.callFunctionOn", (tabId) => dom.onNode(at(tabId), 1, () => 1), {
      ms: 5_000,
    }),
    fault("onNode", "Runtime.releaseObject", (tabId) => dom.onNode(at(tabId), 1, () => 1)),
    fault("readFieldValue", "DOM.resolveNode", (tabId) => dom.readFieldValue(at(tabId), 1), {
      label: "onNode",
    }),
    fault("visibleNodes", "DOM.resolveNode", (tabId) => dom.visibleNodes(at(tabId), [1]), {
      label: "onNode",
    }),
  ];
}

function queryCases() {
  const css = { by: "css", value: "button" };
  return [
    fault("queryNodes", "Runtime.evaluate", (tabId) => dom.queryNodes(at(tabId), css), {
      ms: 5_000,
    }),
    fault("queryNodes", "Runtime.releaseObjectGroup", (tabId) => dom.queryNodes(at(tabId), css)),
    fault("backendIds", "Runtime.getProperties", (tabId) => dom.queryNodes(at(tabId), css)),
    fault("backendIds", "DOM.describeNode", (tabId) => dom.queryNodes(at(tabId), css)),
    fault(
      "scopedBackendIds",
      "DOM.describeNode",
      (tabId) => dom.scopedBackendIds(at(tabId), "button"),
      {
        hang: (_method, params) => params?.depth === -1,
      },
    ),
    fault("isFocusedInput", "Runtime.evaluate", (tabId) => dom.isFocusedInput(at(tabId)), {
      ms: 5_000,
    }),
  ];
}

function fillCases() {
  const fill = (tabId) => dom.fillTextNode(at(tabId), 1, "");
  return [
    fault("fillTextNode", "DOM.resolveNode", fill),
    fault("fillTextNode", "Runtime.callFunctionOn", fill, { ms: 5_000 }),
    fault("fillTextNode", "DOM.describeNode", fill),
    fault("fillTextNode", "Runtime.releaseObjectGroup", fill),
    fault("clearSelection", "Input.dispatchKeyEvent", fill),
  ];
}

function frameCases() {
  return [
    fault("discoverFrames", "Target.setAutoAttach", (tabId) => frames.discoverFrames(at(tabId))),
    fault("discoverFrames", "Page.getFrameTree", (tabId) => frames.discoverFrames(at(tabId))),
    fault(
      "frameDebuggee",
      "Target.setAutoAttach",
      (tabId) => frames.frameDebuggee(at(tabId), "child", "child:l2"),
      { label: "discoverFrames" },
    ),
    fault("frameContext", "Page.createIsolatedWorld", (tabId) =>
      frames.frameContext(at(tabId), "child"),
    ),
    fault(
      "evaluateFrame",
      "Runtime.evaluate",
      (tabId) => frames.evaluateFrame(at(tabId), "child", "1"),
      { ms: 8_000 },
    ),
    ...uploadCases(),
    ...ownerCases(),
  ];
}

function uploadCases() {
  const bySelector = (tabId) =>
    frames.uploadFiles(at(tabId), { step: { op: "upload", selector: "input", files: ["a.txt"] } });
  const byNode = (tabId) =>
    frames.uploadFiles(at(tabId), {
      step: { op: "upload", backendNodeId: 5, files: ["a.txt"] },
    });
  return [
    fault("uploadFiles", "Runtime.evaluate", bySelector, { ms: 5_000 }),
    fault("uploadFiles", "DOM.describeNode", bySelector),
    fault("uploadFiles", "Runtime.releaseObject", bySelector),
    fault("uploadFiles", "DOM.setFileInputFiles", byNode),
  ];
}

function ownerCases() {
  const ax = (tabId) => frames.collectFrameAx(at(tabId), "root", []);
  const point = (tabId) => frames.rootFramePoint(at(tabId), "child", { x: 1, y: 2 });
  return [
    fault("collectFrameAx", "Accessibility.getFullAXTree", ax),
    fault("frameOwnerId", "DOM.getFrameOwner", ax),
    fault("rootFrameId", "Page.getFrameTree", point),
    fault("frameOwner", "DOM.enable", point),
    fault("frameOwner", "DOM.getFrameOwner", point),
    fault("frameOwner", "DOM.getBoxModel", point),
    fault("rootFramePoint", "DOM.describeNode", point),
    fault("trackFrameTarget", "Target.setAutoAttach", trackFrame),
  ];
}

async function trackFrame(tabId) {
  const listener = events.find((fn) => String(fn).includes("function trackFrameTarget"));
  assert.ok(listener, "frame listener was not installed");
  listener({ tabId }, "Target.attachedToTarget", {
    sessionId: "sess",
    targetInfo: { targetId: "tgt", type: "iframe" },
  });
  await pause(callLimitMs("Target.setAutoAttach") + 300);
}

function observeCases() {
  return [
    fault("captureViewport", "Page.getLayoutMetrics", (tabId) =>
      observation.captureViewport(at(tabId)),
    ),
    fault("captureViewport", "Page.enable", (tabId) => observation.captureViewport(at(tabId))),
    fault("captureViewport", "Page.captureScreenshot", (tabId) =>
      observation.captureViewport(at(tabId)),
    ),
    fault(
      "visiblePageText",
      "Runtime.evaluate",
      (tabId) => observation.visiblePageText(at(tabId)),
      {
        ms: 5_000,
      },
    ),
    fault("frame", "Page.captureScreenshot", previewFrame),
  ];
}

async function previewFrame(tabId) {
  session.bindBrowserSession(tabId, "chat");
  const done = new Promise((resolve) => {
    previewResolve = resolve;
  });
  await preview.notePreviewActivity("chat", tabId);
  await done;
}
