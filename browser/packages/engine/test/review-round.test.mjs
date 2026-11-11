import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const tabState = new Map();
let windows = { width: 1400, height: 1000 };
let windowUpdates = 0;
let handler = async (debuggee, method, params) => {
  calls.push({ debuggee, method, params });
  return {};
};

function tabOf(id) {
  return (
    tabState.get(id) ?? {
      id,
      active: true,
      discarded: false,
      status: "complete",
      windowId: 1,
    }
  );
}

globalThis.chrome = {
  debugger: {
    sendCommand: (debuggee, method, params) => handler(debuggee, method, params),
    attach: async () => {
      calls.push({ method: "attach" });
    },
    detach: async () => undefined,
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async (id) => tabOf(id),
    query: async () => [{ id: 1 }],
    update: async () => undefined,
    reload: async () => undefined,
    onRemoved: { addListener() {} },
    onReplaced: { addListener() {} },
    onActivated: { addListener() {} },
  },
  windows: {
    get: async (id) => ({ id, focused: true, state: "normal", ...windows }),
    update: async () => {
      windowUpdates += 1;
      windows = { width: 1400, height: 1000 };
    },
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
  runtime: { onInstalled: { addListener() {} }, getURL: (path) => path },
};

const { beginLazyDomain } = await import("../dist/cdp/domains.js");
const { armDiagnostics, diagnosticsArmed, enableDiagnostics, notePageConsole, readDiagnostics } =
  await import("../dist/native-browser-events.js");
const { fedcmEnabled, forgetFedCm, noteAgentClick } =
  await import("../dist/native-browser-fedcm.js");
const { listensForKeys } = await import("../dist/native-browser-dom.js");
const { setLockWaitMs, withLock } = await import("../dist/native-browser-scheduler.js");
const { inFront } = await import("../dist/native-browser-signin-chrome.js");
const {
  ensureBrowserAttachment,
  ensureBrowserViewport,
  ensureNetwork,
  reconnectBrowserSession,
  wantNetwork,
  withBrowserDebugger,
} = await import("../dist/native-browser-session.js");
const { configureEngine } = await import("../dist/engine-config.js");

configureEngine({
  agentGlow: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(true),
});

function methods(name) {
  return calls.filter((call) => call.method === name);
}

test("a lazy domain is enabled on the same debuggee, marked only after success, and retried", async () => {
  calls.length = 0;
  const debuggee = { tabId: 1, sessionId: "frame-1" };
  const pending = [];
  handler = (_debuggee, method) => {
    calls.push({ debuggee: _debuggee, method });
    return new Promise((resolve) => pending.push(resolve));
  };
  const first = beginLazyDomain(debuggee, "DOM.getDocument");
  const second = beginLazyDomain(debuggee, "DOM.getDocument");
  assert.equal(first, second);
  assert.equal(methods("DOM.enable").length, 1);
  assert.deepEqual(calls[0].debuggee, debuggee);
  const thirdWhileInFlight = beginLazyDomain(debuggee, "Accessibility.getFullAXTree");
  assert.equal(methods("Accessibility.enable").length, 1);
  assert.notEqual(thirdWhileInFlight, undefined);
  for (const resolve of pending) resolve({});
  await first;
  await thirdWhileInFlight;
  assert.equal(beginLazyDomain(debuggee, "DOM.getDocument"), undefined);
  assert.equal(methods("DOM.enable").length, 1);
  assert.equal(beginLazyDomain(debuggee, "Network.getCookies"), undefined);

  handler = () => Promise.reject(new Error("enable failed"));
  const failed = beginLazyDomain({ tabId: 2 }, "DOM.describeNode");
  await failed;
  let retried = 0;
  handler = () => {
    retried += 1;
    return Promise.resolve({});
  };
  const again = beginLazyDomain({ tabId: 2 }, "DOM.describeNode");
  assert.notEqual(again, undefined);
  await again;
  assert.equal(retried, 1);
  assert.equal(beginLazyDomain({ tabId: 2 }, "DOM.describeNode"), undefined);
});

test("Network enable waits until the debugger is attached and is not recorded on failure", async () => {
  calls.length = 0;
  handler = async (debuggee, method) => {
    calls.push({ debuggee, method });
    return {};
  };
  wantNetwork(30);
  await ensureNetwork(30);
  assert.equal(methods("Network.enable").length, 0);
  await ensureBrowserAttachment(30, "chat");
  assert.equal(methods("Network.enable").length, 0);
  assert.equal(diagnosticsArmed(30), true);
  await withBrowserDebugger(30, async () => "ran");
  assert.equal(methods("Network.enable").length, 1);
  await withBrowserDebugger(30, async () => "ran");
  assert.equal(methods("Network.enable").length, 1);
  await reconnectBrowserSession(30);

  let failNetwork = true;
  handler = async (debuggee, method) => {
    calls.push({ debuggee, method });
    if (method === "Network.enable" && failNetwork) throw new Error("network");
    return {};
  };
  wantNetwork(31);
  await ensureBrowserAttachment(31, "chat");
  calls.length = 0;
  const ran = await withBrowserDebugger(31, async () => "continued");
  assert.equal(ran, "continued");
  assert.equal(methods("Network.enable").length, 1);
  failNetwork = false;
  calls.length = 0;
  await withBrowserDebugger(31, async () => "continued");
  assert.equal(methods("Network.enable").length, 1);
  await reconnectBrowserSession(31);
});

test("two Network enables in flight share one command", async () => {
  calls.length = 0;
  handler = async (debuggee, method) => {
    calls.push({ method });
    return {};
  };
  await ensureBrowserAttachment(32, "chat");
  const releases = [];
  handler = (_debuggee, method) => {
    calls.push({ method });
    if (method !== "Network.enable") return Promise.resolve({});
    return new Promise((resolve) => releases.push(() => resolve({})));
  };
  calls.length = 0;
  wantNetwork(32);
  const first = ensureNetwork(32);
  const second = ensureNetwork(32);
  await new Promise((done) => setImmediate(done));
  try {
    assert.equal(methods("Network.enable").length, 1);
  } finally {
    for (const resolve of releases) resolve();
  }
  await Promise.all([first, second]);
  assert.equal(methods("Network.enable").length, 1);
  await reconnectBrowserSession(32);
});

test("FedCM turns on after attach, clears when enable fails, and clears on detach", async () => {
  calls.length = 0;
  handler = async (_debuggee, method) => {
    calls.push({ method });
    return {};
  };
  noteAgentClick(40);
  await new Promise((done) => setImmediate(done));
  assert.equal(methods("FedCm.enable").length, 0);
  await ensureBrowserAttachment(40, "chat");
  assert.equal(methods("FedCm.enable").length, 0);
  let failFedCm = true;
  handler = async (_debuggee, method) => {
    calls.push({ method });
    if (method === "FedCm.enable" && failFedCm) throw new Error("fedcm");
    return {};
  };
  calls.length = 0;
  assert.equal(await withBrowserDebugger(40, async () => "ran"), "ran");
  assert.equal(fedcmEnabled(40), false);
  assert.equal(methods("FedCm.enable").length, 1);
  failFedCm = false;
  calls.length = 0;
  await withBrowserDebugger(40, async () => "ran");
  assert.equal(fedcmEnabled(40), true);
  assert.equal(methods("FedCm.enable").length, 1);
  await reconnectBrowserSession(40);
  assert.equal(fedcmEnabled(40), false);
  noteAgentClick(40);
  calls.length = 0;
  await withBrowserDebugger(40, async () => "ran");
  assert.equal(fedcmEnabled(40), true);
  forgetFedCm(40);
  assert.equal(fedcmEnabled(40), false);
});

test("key listeners on the document count, and a silent chain does not", async () => {
  handler = async (_debuggee, method, params) => {
    calls.push({ method, params });
    if (method === "DOMDebugger.getEventListeners") {
      if (params.objectId === "doc") return { listeners: [{ type: "keydown" }] };
      return { listeners: [] };
    }
    if (method === "Runtime.callFunctionOn") {
      assert.match(params.functionDeclaration, /parentNode/);
      assert.match(params.functionDeclaration, /defaultView/);
      if (params.objectId === "field") return { result: { objectId: "doc" } };
      return { result: {} };
    }
    return {};
  };
  calls.length = 0;
  assert.equal(await listensForKeys({ tabId: 1 }, "field"), true);
  const released = methods("Runtime.releaseObject").map((call) => call.params.objectId);
  assert.equal(released.includes("field"), false);
  assert.equal(released.includes("doc"), true);

  handler = async (_debuggee, method) => {
    if (method === "DOMDebugger.getEventListeners") return { listeners: [] };
    if (method === "Runtime.callFunctionOn") return { result: {} };
    return {};
  };
  assert.equal(await listensForKeys({ tabId: 1 }, "quiet"), false);
});

test("the sign-in window lock covers the focus change and not the fill", async () => {
  setLockWaitMs(300);
  tabState.set(9, {
    id: 9,
    active: false,
    discarded: false,
    status: "complete",
    windowId: 9,
  });
  const order = [];
  chrome.windows.update = async (id, info) => {
    order.push(`focus:${id}:${info.focused}`);
  };
  chrome.tabs.update = async (id, info) => {
    order.push(`tab:${id}:${info.active}`);
  };
  chrome.tabs.query = async () => [{ id: 3 }];
  try {
    const result = await inFront(9, async () => {
      order.push("run");
      await withLock("window:9", async () => {
        order.push("inner");
      });
      return "filled";
    });
    assert.equal(result, "filled");
    assert.deepEqual(order, ["focus:9:true", "tab:9:true", "run", "inner", "tab:3:true"]);
  } finally {
    setLockWaitMs(30_000);
    chrome.windows.update = async () => {
      windowUpdates += 1;
    };
    chrome.tabs.update = async () => undefined;
    chrome.tabs.query = async () => [{ id: 1 }];
  }
});

test("sizing a background window waits for the window lock", async () => {
  setLockWaitMs(2_000);
  let release = () => undefined;
  const held = withLock(
    "window:3",
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  await new Promise((done) => setTimeout(done, 10));
  windows = { width: 800, height: 600 };
  windowUpdates = 0;
  chrome.windows.update = async () => {
    windowUpdates += 1;
    windows = { width: 1400, height: 1000 };
  };
  tabState.set(41, {
    id: 41,
    active: false,
    discarded: false,
    status: "complete",
    windowId: 3,
  });
  try {
    const pending = ensureBrowserViewport(41);
    await new Promise((done) => setTimeout(done, 40));
    assert.equal(windowUpdates, 0);
    release();
    await held;
    await pending;
    assert.equal(windowUpdates, 1);
  } finally {
    setLockWaitMs(30_000);
    windows = { width: 1400, height: 1000 };
  }
});

test("attach arms the diagnostics buffer and does not enable Network", async () => {
  calls.length = 0;
  handler = async (_debuggee, method) => {
    calls.push({ method });
    return {};
  };
  assert.equal(diagnosticsArmed(70), false);
  armDiagnostics(70);
  notePageConsole(70, "log", "armed");
  assert.deepEqual(readDiagnostics(70).console, [{ level: "log", text: "armed" }]);
  assert.equal(methods("Network.enable").length, 0);

  await ensureBrowserAttachment(71, "chat");
  assert.equal(diagnosticsArmed(71), true);
  assert.equal(methods("Network.enable").length, 0);
  assert.ok(methods("Page.enable").length >= 1);
  notePageConsole(71, "warn", "from-page");
  assert.equal(readDiagnostics(71).console[0]?.text, "from-page");
  await enableDiagnostics(71);
  assert.equal(methods("Network.enable").length, 1);
  await reconnectBrowserSession(71);
});
