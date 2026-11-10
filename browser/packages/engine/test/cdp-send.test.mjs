import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BrowserExecutorResultSchema } from "@browserkit/protocol";

const pending = [];
const calls = [];
let hangOn = () => false;
let attachMode = "ok";
let tabActive = false;

function payload(method) {
  if (method === "Accessibility.getFullAXTree") return { nodes: [] };
  if (method === "Page.getLayoutMetrics")
    return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
  if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } };
  return {};
}

function sendCommand(debuggee, method, params) {
  calls.push({ method, debuggee, params });
  if (hangOn(method, params, debuggee)) return new Promise((resolve) => pending.push(resolve));
  return Promise.resolve(payload(method));
}

function attach() {
  if (attachMode === "hang") return new Promise((resolve) => pending.push(resolve));
  if (attachMode === "already") return Promise.reject(new Error("Already attached"));
  return Promise.resolve();
}

function releasePending() {
  for (const resolve of pending.splice(0)) resolve({});
  hangOn = () => false;
  attachMode = "ok";
}

globalThis.chrome = {
  debugger: {
    sendCommand,
    attach,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async (id) => ({ id, active: tabActive, discarded: false, status: "complete" }),
    onRemoved: { addListener() {} },
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

const { callClass, callLimitMs, inflight, recent, send } = await import("../dist/cdp/send.js");
const { engineConfig, configureEngine } = await import("../dist/engine-config.js");
const { beginReceipt, takeReceipt } = await import("../dist/native-browser-receipts.js");
const { setHumanInputEnabled } = await import("../dist/native-browser-human-input.js");
const { targetIdentity } = await import("../dist/native-browser-common.js");
const session = await import("../dist/native-browser-session.js");
const view = await import("../dist/native-browser-debugger.js");
const cdp = await import("../dist/native-browser-cdp.js");

configureEngine({
  agentGlow: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(true),
});
setHumanInputEnabled(false);
engineConfig.cdpLimitFactor = 0.02;

const MARGIN = 2_500;
let tabSeq = 1_000;
const nextTab = () => tabSeq++;

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  assert.ok(Date.now() - started <= cap + 100);
}

function actionResult(lateReply) {
  return {
    kind: "action",
    target: {
      clientInstanceId: "00000000-0000-4000-8000-000000000001",
      browserRunId: "00000000-0000-4000-8000-000000000002",
      tabId: 1,
      tabIncarnation: "00000000-0000-4000-8000-000000000003",
    },
    documentEpoch: 1,
    url: "https://example.test/",
    effect: "confirmed",
    evidence: "late",
    receipt: { popups: [], navigated: false, ...(lateReply ? { lateReply } : {}) },
  };
}

test("bounded CDP send", async (t) => {
  await t.test("class and limit table, widened only by cdpLimitFactor", classTable);
  await t.test("the timeout names the method, label and tab", timeoutNames);
  await t.test(
    "a hung frame blocks the tab, with no read retry, until the late reply",
    hungFrameBlocksTab,
  );
  await t.test(
    "eval requires ms, sets the CDP timeout, and does not copy it onto the caller",
    evalRequiresMs,
  );
  await t.test(
    "an input timeout sets mayHaveLateEffects and the next receipt notes it",
    inputTimeoutNotesReceipt,
  );
  await t.test("a late input that lands before the next receipt says so", lateInputLanded);
  await t.test("the happy path starts sendCommand in this turn", happyPath);
  await t.test("recent keeps the last 200 calls", recentRing);
  await t.test(
    "every migrated function settles when one chosen method never answers",
    everyFunctionSettles,
  );
});

function classTable() {
  engineConfig.cdpLimitFactor = 2;
  assert.equal(callClass("Input.dispatchMouseEvent"), "input");
  assert.equal(callClass("Page.navigate"), "nav");
  assert.equal(callClass("Page.reload"), "nav");
  assert.equal(callClass("Page.navigateToHistoryEntry"), "nav");
  assert.equal(callClass("Runtime.evaluate"), "eval");
  assert.equal(callClass("Runtime.callFunctionOn"), "eval");
  assert.equal(callClass("Runtime.awaitPromise"), "eval");
  assert.equal(callClass("Emulation.setCPUThrottlingRate"), "emulate");
  assert.equal(callClass("Target.attachToTarget"), "attach");
  assert.equal(callClass("DOM.getDocument"), "read");
  assert.equal(callLimitMs("DOM.getDocument"), 10_000);
  assert.equal(callLimitMs("Input.dispatchMouseEvent"), 10_000);
  assert.equal(callLimitMs("Emulation.setCPUThrottlingRate"), 6_000);
  assert.equal(callLimitMs("Target.attachToTarget"), 20_000);
  assert.equal(callLimitMs("Page.navigate"), 60_000);
  assert.equal(callLimitMs("Runtime.evaluate", 4_000), 10_000);
  engineConfig.cdpLimitFactor = 0;
  assert.equal(callLimitMs("DOM.getDocument"), 5_000);
  engineConfig.cdpLimitFactor = 0.02;
}

async function timeoutNames() {
  engineConfig.cdpLimitFactor = 1;
  let release = () => undefined;
  chrome.debugger.sendCommand = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    const pendingCall = send(
      { tabId: 41 },
      "Runtime.evaluate",
      { expression: "1" },
      {
        label: "pageFingerprint",
        ms: 4_000,
      },
    );
    assert.equal(
      inflight().some((item) => item.label === "pageFingerprint"),
      true,
    );
    mock.timers.tick(5_000);
    const error = await pendingCall.then(
      () => {
        throw new Error("resolved");
      },
      (caught) => caught,
    );
    assert.equal(
      error.message,
      "TIMEOUT: Runtime.evaluate (pageFingerprint) did not answer in 5.0 s on tab 41",
    );
    const blocked = await send({ tabId: 41 }, "DOM.getDocument", undefined, {
      label: "probe",
    }).then(
      () => {
        throw new Error("resolved");
      },
      (caught) => caught,
    );
    assert.match(blocked.message, /has not answered an earlier call yet/);
  } finally {
    engineConfig.cdpLimitFactor = 0.02;
    chrome.debugger.sendCommand = sendCommand;
    release();
    mock.timers.reset();
    await pause(0);
  }
}

async function hungFrameBlocksTab() {
  let started = 0;
  const releases = [];
  chrome.debugger.sendCommand = (debuggee, method, params) => {
    started += 1;
    calls.push({ method, debuggee, params });
    if (debuggee.tabId === 77) return new Promise((resolve) => releases.push(resolve));
    return Promise.resolve({ ok: true });
  };
  const first = send({ tabId: 77, sessionId: "frame" }, "DOM.getDocument", undefined, {
    label: "frameRead",
  });
  assert.equal(started, 1);
  const other = await send({ tabId: 78 }, "DOM.getDocument", undefined, { label: "other" });
  assert.deepEqual(other, { ok: true });
  const error = await first.then(
    () => {
      throw new Error("resolved");
    },
    (caught) => caught,
  );
  assert.match(error.message, /TAB_UNRESPONSIVE: DOM\.getDocument \(frameRead\)/);
  const before = started;
  const blocked = await send({ tabId: 77 }, "Page.getFrameTree", undefined, {
    label: "next",
  }).then(
    () => {
      throw new Error("resolved");
    },
    (caught) => caught,
  );
  assert.equal(started, before);
  assert.match(blocked.message, /has not answered an earlier call yet/);
  releases.splice(0).forEach((resolve) => resolve({}));
  await pause(0);
  const row = recent(77).find((item) => item.label === "frameRead");
  assert.equal(row.ok, false);
  assert.equal(row.late, true);
  assert.equal(
    inflight().some((item) => item.tabId === 77),
    false,
  );
  chrome.debugger.sendCommand = sendCommand;
}

async function evalRequiresMs() {
  let seen;
  let count = 0;
  chrome.debugger.sendCommand = (_debuggee, _method, params) => {
    count += 1;
    seen = params;
    return Promise.resolve({ result: { value: 1 } });
  };
  const missing = await send(
    { tabId: 4 },
    "Runtime.evaluate",
    { expression: "1" },
    {
      label: "pageFingerprint",
    },
  ).then(
    () => {
      throw new Error("resolved");
    },
    (caught) => caught,
  );
  assert.equal(count, 0);
  assert.match(missing.message, /TIMEOUT: Runtime\.evaluate \(pageFingerprint\) needs ms/);
  const params = { expression: "1" };
  await send({ tabId: 4 }, "Runtime.evaluate", params, { label: "pageFingerprint", ms: 4_000 });
  assert.equal(seen.timeout, 4_000);
  assert.equal(seen.expression, "1");
  assert.equal("timeout" in params, false);
  chrome.debugger.sendCommand = sendCommand;
}

async function inputTimeoutNotesReceipt() {
  const tabId = 80;
  let release = () => undefined;
  chrome.debugger.sendCommand = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  beginReceipt(tabId);
  const hung = send(
    { tabId },
    "Input.dispatchMouseEvent",
    { type: "mousePressed" },
    {
      label: "clickAt",
    },
  );
  const error = await hung.then(
    () => {
      throw new Error("resolved");
    },
    (caught) => caught,
  );
  assert.equal(error.mayHaveLateEffects, true);
  assert.match(error.message, /\{"mayHaveLateEffects":true\}/);
  assert.equal(takeReceipt(tabId).lateReply, undefined);
  beginReceipt(tabId);
  assert.match(
    takeReceipt(tabId).lateReply ?? "",
    /late reply: Input\.dispatchMouseEvent \(clickAt\)/,
  );
  release();
  chrome.debugger.sendCommand = sendCommand;
  const parsed = BrowserExecutorResultSchema.safeParse(
    actionResult("late reply: Input.dispatchMouseEvent (clickAt)"),
  );
  assert.equal(parsed.success, true);
  releasePending();
  await pause(0);
}

async function lateInputLanded() {
  const tabId = 81;
  const releases = [];
  chrome.debugger.sendCommand = () => new Promise((resolve) => releases.push(resolve));
  const hung = send(
    { tabId },
    "Input.dispatchMouseEvent",
    { type: "mouseWheel" },
    {
      label: "scrollAt",
    },
  );
  await hung.catch(() => undefined);
  releases.splice(0).forEach((resolve) => resolve({}));
  await pause(0);
  beginReceipt(tabId);
  assert.match(takeReceipt(tabId).lateReply ?? "", /late reply landed: Input\.dispatchMouseEvent/);
  chrome.debugger.sendCommand = sendCommand;
}

async function happyPath() {
  let started = 0;
  chrome.debugger.sendCommand = () => {
    started += 1;
    return Promise.resolve({ ok: 1 });
  };
  const pendingCall = send({ tabId: 5 }, "DOM.getDocument", undefined, { label: "bench" });
  assert.equal(started, 1);
  assert.deepEqual(await pendingCall, { ok: 1 });
  const wrapped = await timed(async () => {
    for (let i = 0; i < 400; i += 1)
      await send({ tabId: 5 }, "DOM.getDocument", undefined, { label: "bench" });
  });
  const raw = await timed(async () => {
    for (let i = 0; i < 400; i += 1)
      await chrome.debugger.sendCommand({ tabId: 5 }, "DOM.getDocument");
  });
  assert.ok(wrapped < 1_000, `wrapped ${wrapped}ms raw ${raw}ms`);
  assert.ok(wrapped < raw * 8 + 200, `wrapped ${wrapped}ms raw ${raw}ms`);
  chrome.debugger.sendCommand = sendCommand;
}

async function recentRing() {
  chrome.debugger.sendCommand = () => Promise.resolve({});
  for (let i = 0; i < 201; i += 1)
    await send({ tabId: 9_000 }, "DOM.describeNode", undefined, { label: `n${i}` });
  const rows = recent(9_000);
  assert.equal(rows.length, 200);
  assert.equal(rows[0].label, "n1");
  assert.equal(rows.at(-1).label, "n200");
  assert.equal(rows.at(-1).ok, true);
  chrome.debugger.sendCommand = sendCommand;
}

async function everyFunctionSettles() {
  for (const item of cases()) {
    calls.length = 0;
    hangOn = item.hang;
    attachMode = item.attach ?? "ok";
    tabActive = item.active ?? false;
    const tabId = nextTab();
    try {
      await settled(() => item.run(tabId), item.limit(), item.times ?? 1);
      if (item.method !== "Debugger.attach")
        assert.ok(
          calls.some((call) => call.method === item.method),
          `${item.name} never sent ${item.method}`,
        );
      item.check?.();
    } finally {
      releasePending();
      await pause(0);
    }
  }
}

function timed(run) {
  const started = globalThis.performance.now();
  return run().then(() => globalThis.performance.now() - started);
}

function refTarget(tabId) {
  return {
    clientInstanceId: "00000000-0000-4000-8000-000000000001",
    browserRunId: "00000000-0000-4000-8000-000000000002",
    tabId,
    tabIncarnation: "00000000-0000-4000-8000-000000000003",
  };
}

async function resolveFrame(tabId) {
  const target = refTarget(tabId);
  const snapshotId = "snap";
  const refs = new Map([
    [
      snapshotId,
      new Map([
        [
          "e1",
          { backendNodeId: 5, role: "button", name: "Go", sessionId: "frame", documentEpoch: 1 },
        ],
      ]),
    ],
  ]);
  await view.resolveElement(
    { tabId },
    { kind: "ref", snapshotId, ref: "e1" },
    target,
    refs,
    new Map([[targetIdentity(target), snapshotId]]),
    1,
  );
}

function command(tabId, method, params = {}) {
  let resolve;
  const done = new Promise((finish) => {
    resolve = finish;
  });
  cdp.noteCdpSocket(
    {
      readyState: 1,
      send(text) {
        resolve(JSON.parse(text));
      },
    },
    { clientInstanceId: "chat-1" },
  );
  cdp.handleCdpMessage({ kind: "cdp.command", id: `c${tabId}`, tabId, method, params });
  return done;
}

async function attachedThen(tabId, run) {
  hangOn = () => false;
  attachMode = "ok";
  await session.ensureBrowserAttachment(tabId, "chat");
  hangOn = (_method, params) =>
    params?.enabled === false && calls.at(-1)?.method === "Emulation.setFocusEmulationEnabled";
  // The predicate above sees the call only after it is recorded. Set it before the run.
  hangOn = (_method, params) => params?.enabled === false;
  await run();
}

function cases() {
  const limits = {
    read: () => callLimitMs("Page.enable"),
    input: () => callLimitMs("Input.dispatchMouseEvent"),
    emulate: () => callLimitMs("Emulation.setDeviceMetricsOverride"),
    attachLimit: () => callLimitMs("Target.attachToTarget"),
  };
  return [
    ...attachFaults(limits),
    ...sessionFaults(limits),
    ...viewFaults(limits),
    ...commandFaults(limits),
  ];
}

function attachFaults({ read, emulate, attachLimit }) {
  return [
    fault("attach", "Debugger.attach", attachLimit, (tabId) => {
      attachMode = "hang";
      return session.ensureBrowserAttachment(tabId, "chat");
    }),
    fault(
      "enablePage",
      "Page.enable",
      read,
      (tabId) => session.ensureBrowserAttachment(tabId, "chat"),
      {
        check: () => assert.ok(calls.some((item) => item.method === "Page.setWebLifecycleState")),
      },
    ),
    fault(
      "enablePage wake",
      "Page.setWebLifecycleState",
      read,
      (tabId) => session.ensureBrowserAttachment(tabId, "chat"),
      {
        times: 2,
        hang: (method) => method === "Page.enable" || method === "Page.setWebLifecycleState",
      },
    ),
    fault("attach domains", "DOM.enable", read, (tabId) =>
      session.ensureBrowserAttachment(tabId, "chat"),
    ),
    fault("attach domains", "Accessibility.enable", read, (tabId) =>
      session.ensureBrowserAttachment(tabId, "chat"),
    ),
    fault("attach focus", "Emulation.setFocusEmulationEnabled", emulate, (tabId) =>
      session.ensureBrowserAttachment(tabId, "chat"),
    ),
    fault(
      "already attached",
      "Page.getFrameTree",
      read,
      (tabId) => {
        attachMode = "already";
        return session.ensureBrowserAttachment(tabId, "chat");
      },
      { attach: "already" },
    ),
  ];
}

function sessionFaults({ read, emulate }) {
  return [
    fault("ensureBrowserViewport", "Emulation.setDeviceMetricsOverride", emulate, (tabId) =>
      session.ensureBrowserViewport(tabId),
    ),
    fault("restoreBrowserViewport", "Emulation.clearDeviceMetricsOverride", emulate, (tabId) =>
      session.restoreBrowserViewport(tabId),
    ),
    fault("withBrowserDebugger", "Page.enable", read, async (tabId) => {
      session.bindBrowserSession(tabId, "chat");
      tabActive = true;
      await session.withBrowserDebugger(tabId, async () => undefined);
    }),
    fault(
      "releaseBrowserSessions",
      "Emulation.setFocusEmulationEnabled",
      emulate,
      (tabId) => attachedThen(tabId, () => session.releaseBrowserSessions("chat")),
      { hang: (_method, params) => params?.enabled === false },
    ),
  ];
}

function viewFaults({ read, input }) {
  return [
    fault("getAxTree", "Accessibility.getFullAXTree", read, (tabId) => view.getAxTree({ tabId })),
    fault("getAxTree", "Page.getFrameTree", read, (tabId) => view.getAxTree({ tabId })),
    fault("getViewportSize", "Page.getLayoutMetrics", read, (tabId) =>
      view.getViewportSize({ tabId }),
    ),
    fault("getViewportCenter", "Page.getLayoutMetrics", read, (tabId) =>
      view.getViewportCenter({ tabId }),
    ),
    fault("getCenter", "DOM.scrollIntoViewIfNeeded", read, (tabId) => view.getCenter({ tabId }, 5)),
    fault("getCenter", "DOM.getBoxModel", read, (tabId) => view.getCenter({ tabId }, 5)),
    fault("clickAt", "Input.dispatchMouseEvent", input, (tabId) => view.clickAt({ tabId }, 4, 5)),
    fault("scrollAt", "Input.dispatchMouseEvent", input, (tabId) =>
      view.scrollAt({ tabId }, 4, 5, "down", 80),
    ),
    fault("resolveElement", "Accessibility.getFullAXTree", read, (tabId) => resolveFrame(tabId), {
      hang: (method, _params, debuggee) =>
        method === "Accessibility.getFullAXTree" && debuggee?.sessionId,
    }),
  ];
}

function commandFaults({ read, input, emulate, attachLimit }) {
  return [
    fault("runCommand", "DOM.getDocument", read, (tabId) => command(tabId, "DOM.getDocument")),
    fault("runCommand", "Input.dispatchMouseEvent", input, (tabId) =>
      command(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved" }),
    ),
    fault(
      "runCommand",
      "Page.navigate",
      () => callLimitMs("Page.navigate"),
      (tabId) => command(tabId, "Page.navigate", { url: "https://example.test/" }),
    ),
    fault("runCommand", "Emulation.setCPUThrottlingRate", emulate, (tabId) =>
      command(tabId, "Emulation.setCPUThrottlingRate", { rate: 2 }),
    ),
    fault(
      "runCommand",
      "Runtime.evaluate",
      () => callLimitMs("Runtime.evaluate", 5_000),
      (tabId) => command(tabId, "Runtime.evaluate", { expression: "1", timeout: 5_000 }),
    ),
    fault("runCommand", "Target.attachToTarget", attachLimit, (tabId) =>
      command(tabId, "Target.attachToTarget", { targetId: "t" }),
    ),
  ];
}

function fault(name, method, limit, run, extra = {}) {
  return {
    name,
    method,
    limit,
    run,
    times: extra.times,
    attach: extra.attach,
    active: extra.active,
    check: extra.check,
    hang: extra.hang ?? ((next) => next === method),
  };
}
