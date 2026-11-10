import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const calls = [];
const listeners = new Map();
let hangOn = () => false;
let failOn = () => false;
let tabSeq = 5_000;
const nextTab = () => tabSeq++;
const MARGIN = 2_500;

function addListener(path, fn) {
  const list = listeners.get(path) ?? [];
  list.push(fn);
  listeners.set(path, list);
}

function removeListener(path, fn) {
  const list = listeners.get(path) ?? [];
  const index = list.indexOf(fn);
  if (index >= 0) list.splice(index, 1);
}

function fire(path, ...args) {
  for (const fn of [...(listeners.get(path) ?? [])]) fn(...args);
}

function payload(method) {
  if (method === "Page.getFrameTree")
    return { frameTree: { frame: { id: "f1", url: "https://example.test/", loaderId: "L" } } };
  if (method === "Runtime.evaluate") return { result: { value: "https://example.test/|1|1" } };
  if (method === "Accessibility.getFullAXTree") return { nodes: [] };
  if (method === "Network.getResponseBody") return { body: '{"ok":true}', base64Encoded: false };
  return {};
}

function sendCommand(_debuggee, method, params) {
  calls.push({ method, params });
  if (failOn(method, params)) return Promise.reject(new Error("inspector detached"));
  if (hangOn(method, params)) return new Promise(() => {});
  return Promise.resolve(payload(method));
}

function offscreen(message) {
  if (message?.kind === "ping") return { ok: true };
  if (message?.kind === "recordStart") return { ok: true, mimeType: "video/webm" };
  if (message?.kind === "recordStop") return { ok: true, bytes: 4, mimeType: "video/webm" };
  return { ok: true };
}

function chromeCall(path, args) {
  if (path === "debugger.sendCommand") return sendCommand(...args);
  if (path === "tabs.get") return tabInfo(args[0]);
  if (path === "runtime.sendMessage") return offscreen(args[0]);
  if (path === "tabCapture.getMediaStreamId") return Promise.reject(new Error("no user gesture"));
  if (path === "offscreen.hasDocument") return true;
  if (path.endsWith(".get") || path.endsWith(".set")) return {};
  if (path.endsWith(".query") || path === "debugger.getTargets") return [];
  return {};
}

function tabInfo(id) {
  return {
    id,
    active: true,
    discarded: false,
    status: "complete",
    url: "https://example.test/",
  };
}

function chromeNode(path) {
  return new Proxy(function chromeFn() {}, {
    get(_target, prop) {
      if (prop === "then" || typeof prop !== "string") return undefined;
      if (prop === "addListener") return (fn) => addListener(path, fn);
      if (prop === "removeListener") return (fn) => removeListener(path, fn);
      if (prop === "hasListener") return (fn) => (listeners.get(path) ?? []).includes(fn);
      return chromeNode(path ? `${path}.${prop}` : prop);
    },
    apply(_target, _thisArg, args) {
      return Promise.resolve(chromeCall(path, args));
    },
  });
}

globalThis.chrome = chromeNode("");

const { callLimitMs, recent } = await import("../dist/cdp/send.js");
const { configureEngine, engineConfig } = await import("../dist/engine-config.js");
const navigation = await import("../dist/native-browser-navigation.js");
const events = await import("../dist/native-browser-events.js");
const network = await import("../dist/native-browser-network.js");
const recording = await import("../dist/native-browser-recording.js");
const session = await import("../dist/native-browser-session.js");
const executor = await import("../dist/native-browser-executor.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");

configureEngine({
  agentGlow: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(true),
});
engineConfig.cdpLimitFactor = 0.02;
installEngineListeners();

test.after(async () => {
  await session.releaseBrowserSessions();
});

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capFor(method, ms) {
  return callLimitMs(method, ms) + MARGIN;
}

async function settles(run, cap) {
  const started = Date.now();
  const status = await Promise.race([
    Promise.resolve(run()).then(
      () => "settled",
      () => "settled",
    ),
    pause(cap).then(() => "hung"),
  ]);
  assert.equal(status, "settled");
  assert.ok(Date.now() - started <= cap + 150, String(Date.now() - started));
}

function named(tabId, method, label) {
  return recent(tabId).some((row) => row.method === method && row.label === label);
}

function target(tabId) {
  return {
    clientInstanceId: "00000000-0000-4000-8000-000000000001",
    browserRunId: "00000000-0000-4000-8000-000000000002",
    tabId,
    tabIncarnation: "00000000-0000-4000-8000-000000000003",
  };
}

function request(step) {
  return {
    kind: "browser.operation",
    requestId: randomUUID(),
    operationId: "op",
    toolCallId: "tool",
    chatId: "chat",
    step,
  };
}

async function withHang(pred, run) {
  hangOn = pred;
  failOn = () => false;
  calls.length = 0;
  try {
    return await run();
  } finally {
    hangOn = () => false;
    failOn = () => false;
  }
}

function traffic(tabId, id) {
  const source = { tabId };
  fire("debugger.onEvent", source, "Network.requestWillBeSent", {
    requestId: id,
    type: "Fetch",
    wallTime: Date.now() / 1000,
    request: { url: "https://example.test/api", method: "GET", headers: {} },
  });
  fire("debugger.onEvent", source, "Network.responseReceived", {
    requestId: id,
    response: { status: 200, statusText: "OK", mimeType: "application/json", headers: {} },
  });
  fire("debugger.onEvent", source, "Network.loadingFinished", {
    requestId: id,
    encodedDataLength: 12,
  });
}

test("S4 call sites use one bounded send", async (t) => {
  await t.test("a fingerprint keeps the caller's timeout", callerTimeout);
  await t.test("probe and viewport settle when evaluate never answers", observation);
  await t.test("navigateReady settles when Page.navigate never answers", hungNavigate);
  await t.test("page.cdp keeps its catch-free failure and eval timeout", pageCdp);
  await t.test("page.evaluate settles inside the old 15s wall", hungEvaluate);
  await t.test("diagnostics and console capture still swallow a failed send", diagnostics);
  await t.test("event subscribe and file-chooser dispose stay bounded", eventPaths);
  await t.test("a screencast ack is named and bounded", ackFrame);
  await t.test("a recorded response body is fetched, and a hung fetch ends", responseBody);
  await t.test("starting a recording re-enables the network domain", networkStart);
  await t.test("a direct screencast bounds focus emulation and the cast", screencast);
  await t.test("frame and readiness evaluates are named and bounded", executorPaths);
});

async function callerTimeout() {
  const tabId = nextTab();
  calls.length = 0;
  hangOn = () => false;
  assert.equal(await navigation.pageFingerprint({ tabId }, 1_500), "https://example.test/|1|1");
  const call = calls.find((item) => item.method === "Runtime.evaluate");
  assert.equal(call.params.timeout, 1_500);
  assert.equal(named(tabId, "Runtime.evaluate", "readFingerprint"), true);
}

async function observation() {
  const probeTab = nextTab();
  await withHang(
    (method) => method === "Runtime.evaluate",
    () =>
      settles(
        () => navigation.primeBrowserSettle({ tabId: probeTab }),
        capFor("Runtime.evaluate", 5_000),
      ),
  );
  assert.equal(named(probeTab, "Runtime.evaluate", "probe"), true);
  const viewTab = nextTab();
  await withHang(
    (method) => method === "Runtime.evaluate",
    () =>
      settles(
        () => navigation.viewportFingerprint({ tabId: viewTab }),
        capFor("Runtime.evaluate", 5_000),
      ),
  );
  assert.equal(named(viewTab, "Runtime.evaluate", "viewportFingerprint"), true);
}

async function hungNavigate() {
  const tabId = nextTab();
  await withHang(
    (method) => method === "Page.navigate",
    () =>
      settles(
        () =>
          navigation.navigateReady(tabId, "https://example.test/next", 30_000, "https://ref.test/"),
        capFor("Page.navigate"),
      ),
  );
  assert.equal(named(tabId, "Page.navigate", "navigateReady"), true);
}

async function pageCdp() {
  const readTab = nextTab();
  await withHang(
    (method) => method === "DOM.getDocument",
    () =>
      settles(() => runCdp(readTab, "DOM.getDocument", { depth: 1 }), capFor("DOM.getDocument")),
  );
  const read = calls.find((item) => item.method === "DOM.getDocument");
  assert.equal(read.params.depth, 1);
  assert.equal("timeout" in read.params, false);
  assert.equal(named(readTab, "DOM.getDocument", "executePageCode"), true);
  await hungEval(nextTab(), "1", 2_500);
  await hungEval(nextTab(), "2", undefined);
}

async function hungEval(tabId, expression, timeout) {
  const params = timeout === undefined ? { expression } : { expression, timeout };
  await withHang(
    (method, sent) => method === "Runtime.evaluate" && sent?.expression === expression,
    () =>
      settles(
        () => runCdp(tabId, "Runtime.evaluate", params),
        capFor("Runtime.evaluate", timeout ?? 5_000),
      ),
  );
  const call = calls.find((item) => item.params?.expression === expression);
  assert.equal(call.params.timeout, timeout ?? 5_000);
  assert.equal(named(tabId, "Runtime.evaluate", "executePageCode"), true);
}

function runCdp(tabId, method, params) {
  return navigation.executePageCode(
    { tabId },
    request({ op: "cdp", method, params, target: target(tabId) }),
    async () => {},
  );
}

async function hungEvaluate() {
  const tabId = nextTab();
  await withHang(
    (method, params) => method === "Runtime.evaluate" && params?.expression === "1",
    () =>
      settles(
        () =>
          navigation.executePageCode(
            { tabId },
            request({ op: "evaluate", expression: "1", target: target(tabId) }),
            async () => {},
          ),
        4_000,
      ),
  );
  assert.equal(named(tabId, "Runtime.evaluate", "evaluatePage"), true);
  assert.equal(named(tabId, "Runtime.terminateExecution", "evaluationTimeout"), true);
}

async function diagnostics() {
  const tabId = nextTab();
  await withHang(
    (method) => method === "Network.enable",
    () => settles(() => events.enableDiagnostics(tabId), capFor("Network.enable")),
  );
  assert.equal(recent(tabId).find((row) => row.label === "enableDiagnostics")?.ok, false);
  const thrown = nextTab();
  failOn = (method) => method === "Network.enable";
  await events.enableDiagnostics(thrown);
  failOn = () => false;
  assert.equal(named(thrown, "Network.enable", "enableDiagnostics"), true);
  await consoleCapture();
}

async function consoleCapture() {
  const tabId = nextTab();
  calls.length = 0;
  hangOn = () => false;
  await events.enableConsoleCapture(tabId);
  assert.equal(
    calls.some((call) => call.method === "Runtime.enable"),
    true,
  );
  await withHang(
    (method) => method === "Runtime.disable",
    () => settles(() => events.disableConsoleCapture(tabId), capFor("Runtime.disable")),
  );
  assert.equal(named(tabId, "Runtime.disable", "disableConsoleCapture"), true);
}

async function eventPaths() {
  const tabId = nextTab();
  await withHang(
    (method) => method === "Page.enable",
    () => settles(() => subscribe(tabId, "Page.loadEventFired"), capFor("Page.enable")),
  );
  assert.equal(named(tabId, "Page.enable", "subscribe"), true);
  await fileChooser();
}

async function fileChooser() {
  const tabId = nextTab();
  hangOn = () => false;
  calls.length = 0;
  const subscribed = await subscribe(tabId, "Page.fileChooserOpened");
  assert.equal(chooserCalls(true), true);
  await withHang(
    (method, params) =>
      method === "Page.setInterceptFileChooserDialog" && params?.enabled === false,
    () =>
      settles(
        () =>
          events.executeBrowserEvent(
            request({
              op: "event",
              action: "dispose",
              subscriptionId: subscribed.subscriptionId,
              target: target(tabId),
            }),
            { tabId },
          ),
        capFor("Page.setInterceptFileChooserDialog"),
      ),
  );
  assert.equal(named(tabId, "Page.setInterceptFileChooserDialog", "executeBrowserEvent"), true);
}

function subscribe(tabId, event) {
  return events.executeBrowserEvent(
    request({ op: "event", action: "subscribe", event, target: target(tabId) }),
    { tabId },
  );
}

function chooserCalls(enabled) {
  return calls.some(
    (call) =>
      call.method === "Page.setInterceptFileChooserDialog" && call.params.enabled === enabled,
  );
}

async function ackFrame() {
  const tabId = nextTab();
  const cap = capFor("Page.screencastFrameAck");
  await withHang(
    (method) => method === "Page.screencastFrameAck",
    () => waitNamed(tabId, "Page.screencastFrameAck", "acknowledgeFrame", cap),
  );
}

async function waitNamed(tabId, method, label, cap) {
  fire("debugger.onEvent", { tabId }, "Page.screencastFrame", { sessionId: 7 });
  const started = Date.now();
  while (!named(tabId, method, label)) {
    if (Date.now() - started > cap) assert.fail(`${label} did not settle`);
    await pause(10);
  }
}

async function responseBody() {
  const tabId = nextTab();
  hangOn = () => false;
  await network.learnUserTab(tabId, true);
  assert.equal(named(tabId, "Network.enable", "learnUserTab"), true);
  traffic(tabId, "r1");
  assert.deepEqual(await network.networkCall(tabId, "body", { id: "r1" }), { ok: true });
  const hung = nextTab();
  await network.learnUserTab(hung, true);
  await withHang(
    (method) => method === "Network.getResponseBody",
    async () => {
      traffic(hung, "r2");
      await settles(
        () => network.networkCall(hung, "body", { id: "r2" }),
        capFor("Network.getResponseBody"),
      );
    },
  );
  assert.equal(named(hung, "Network.getResponseBody", "command"), true);
}

async function networkStart() {
  const tabId = nextTab();
  session.bindBrowserSession(tabId, "chat");
  await withHang(
    (method) => method === "Target.setAutoAttach",
    () => settles(() => network.networkCall(tabId, "start", {}), capFor("Target.setAutoAttach")),
  );
  assert.equal(named(tabId, "Network.enable", "resumeNetwork"), true);
  assert.equal(named(tabId, "Network.enable", "enableNetwork"), true);
  assert.equal(named(tabId, "Target.setAutoAttach", "enableNetwork"), true);
}

async function screencast() {
  const cast = nextTab();
  await withHang(
    (method) => method === "Page.startScreencast",
    () =>
      settles(
        () => recording.recordingCall(cast, { recording: "start", direct: true }),
        capFor("Page.startScreencast"),
      ),
  );
  assert.equal(named(cast, "Page.startScreencast", "debug"), true);
  const focus = nextTab();
  await withHang(
    (method) => method === "Emulation.setFocusEmulationEnabled",
    () =>
      settles(
        () => recording.recordingCall(focus, { recording: "start", direct: true }),
        capFor("Emulation.setFocusEmulationEnabled") + 500,
      ),
  );
  assert.equal(named(focus, "Emulation.setFocusEmulationEnabled", "attachDirect"), true);
}

async function executorPaths() {
  await readiness();
  await frameSnapshot();
  await frameEval();
}

async function readiness() {
  const tabId = nextTab();
  session.bindBrowserSession(tabId, "chat");
  await withHang(
    (method) => method === "Runtime.evaluate",
    () =>
      settles(
        () =>
          executor.performExtra(
            request({ op: "readiness", target: target(tabId) }),
            async () => {},
          ),
        capFor("Runtime.evaluate", 5_000),
      ),
  );
  assert.equal(named(tabId, "Runtime.evaluate", "evaluate"), true);
}

async function frameSnapshot() {
  const tabId = nextTab();
  session.bindBrowserSession(tabId, "chat");
  await withHang(
    (method) => method === "Accessibility.getFullAXTree",
    () =>
      settles(() => frames(tabId, { action: "snapshot" }), capFor("Accessibility.getFullAXTree")),
  );
  assert.equal(named(tabId, "Accessibility.getFullAXTree", "frameSnapshot"), true);
}

async function frameEval() {
  const tabId = nextTab();
  session.bindBrowserSession(tabId, "chat");
  await withHang(
    (method, params) => method === "Runtime.evaluate" && params?.expression === "1",
    () =>
      settles(
        () =>
          frames(tabId, {
            action: "cdp",
            method: "Runtime.evaluate",
            params: { expression: "1", timeout: 1_500 },
          }),
        capFor("Runtime.evaluate", 1_500),
      ),
  );
  const call = calls.find((item) => item.params?.expression === "1");
  assert.equal(call.params.timeout, 1_500);
  assert.equal(named(tabId, "Runtime.evaluate", "executeFrame"), true);
}

function frames(tabId, step) {
  return executor.performCapability(
    request({ op: "frames", frameId: "f1", frameKey: "f1:L", target: target(tabId), ...step }),
    async () => {},
  );
}
