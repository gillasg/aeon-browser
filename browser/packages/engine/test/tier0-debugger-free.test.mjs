import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const attaches = [];
const detaches = [];
const scripts = [];
const session = {};
const local = {};
const TAB_ID = 7;
let nodeAtPoint = () => ({ backendNodeId: 42 });

function sink() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

function tab() {
  return {
    id: TAB_ID,
    windowId: 1,
    index: 0,
    url: "https://example.test/",
    title: "Example",
    status: "complete",
    active: false,
    pinned: false,
    discarded: false,
    incognito: false,
    groupId: -1,
  };
}

function windowInfo() {
  return {
    id: 1,
    focused: true,
    state: "normal",
    type: "normal",
    width: 1400,
    height: 1000,
    incognito: false,
  };
}

function sendCommand(_debuggee, method, params) {
  calls.push({ method, params, at: Date.now() });
  if (method === "Page.getFrameTree")
    return Promise.resolve({ frameTree: { frame: { id: "frame" } } });
  if (method === "Page.createIsolatedWorld") return Promise.resolve({ executionContextId: 3 });
  if (method === "DOM.resolveNode") return Promise.resolve({ object: { objectId: "obj" } });
  if (method === "Runtime.callFunctionOn")
    return Promise.resolve({ result: { value: nodeAtPoint(params).backendNodeId === 42 } });
  if (method === "Runtime.evaluate") {
    const expression = String(params?.expression ?? "");
    if (expression.includes("__uxQuiet")) {
      return Promise.resolve({
        result: {
          value: {
            ready: "complete",
            idle: 1e15,
            url: "https://example.test/",
            document: "doc-1",
            changes: 1,
          },
        },
      });
    }
    return Promise.resolve({ result: { value: "ok" } });
  }
  return Promise.resolve({});
}

globalThis.chrome = {
  debugger: {
    sendCommand,
    attach: async (target) => void attaches.push(target),
    detach: async (target) => void detaches.push(target),
    getTargets: async () => [],
    onDetach: sink(),
    onEvent: sink(),
  },
  tabs: {
    get: async () => tab(),
    query: async () => [tab()],
    reload: async () => undefined,
    onCreated: sink(),
    onUpdated: sink(),
    onMoved: sink(),
    onAttached: sink(),
    onActivated: sink(),
    onRemoved: sink(),
    onReplaced: sink(),
  },
  windows: {
    get: async () => windowInfo(),
    getAll: async () => [windowInfo()],
    update: async () => windowInfo(),
    onCreated: sink(),
    onRemoved: sink(),
    onFocusChanged: sink(),
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  storage: {
    session: {
      get: async (key) => (key ? { [key]: session[key] } : { ...session }),
      set: async (items) => Object.assign(session, items),
    },
    local: {
      get: async (key) => (key ? { [key]: local[key] } : { ...local }),
      set: async (items) => Object.assign(local, items),
    },
  },
  runtime: { getURL: (path) => `chrome-extension://graft/${path}` },
  scripting: { executeScript: async (options) => runScript(options) },
  dom: { openOrClosedShadowRoot: (element) => element.closedRoot ?? null },
};

let runScript = async (options) => {
  scripts.push(options);
  return [{ result: options.func(...(options.args ?? [])) }];
};

const { tier0Step } = await import("../dist/native-browser-tier0-step.js");
const { SLOW_FRAME_MS, extractDeep, runTier0, tier0Plan } =
  await import("../dist/native-browser-tier0.js");
const { __readMarkdown, __readMetadata, __readPageData, __pageRequest } =
  await import("../dist/page-readers.js");
const { browserDataApi } = await import("../dist/code-api-data.js");
const session0 = await import("../dist/native-browser-session.js");

const TARGET = {
  clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
  browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
  tabId: TAB_ID,
  tabIncarnation: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f9",
};
const CHAT = "22222222-2222-4222-8222-222222222222";
const expr = (fn, arg) => "(" + fn.toString() + ")(" + (JSON.stringify(arg) ?? "") + ")";

function fakeElement(text, attrs = {}, children = [], closedRoot) {
  return {
    innerText: text,
    getAttribute: (name) => attrs[name] ?? null,
    closedRoot,
    children,
  };
}
function fakeRoot(elements, selectorHits) {
  return {
    querySelectorAll: (selector) => (selector === "*" ? elements : selectorHits(elements)),
  };
}

test("the realm sends the exact reader source the debugger-free path recognises", () => {
  assert.ok(browserDataApi.includes(__readMarkdown.toString()));
  assert.ok(browserDataApi.includes(__readMetadata.toString()));
  assert.ok(browserDataApi.includes(__pageRequest.toString()));
  assert.ok(tier0Plan(expr(__readMarkdown, { max: 100 })));
  assert.ok(
    tier0Plan("(" + __readPageData + ")(" + __readMetadata + ", " + JSON.stringify({}) + ")"),
  );
  assert.ok(tier0Plan(expr(__readMetadata)));
  assert.ok(tier0Plan(expr(() => document.title)));
  assert.equal(tier0Plan("document.body.click()"), undefined, "arbitrary code goes to CDP");
});

test("read-only steps never attach the debugger", async () => {
  globalThis.document = {
    title: "Example",
    ...fakeRoot([fakeElement("Hello", { href: "/a" })], (els) => els),
  };
  globalThis.location = { href: "https://example.test/", origin: "https://example.test" };
  const steps = [
    { op: "read", target: TARGET, selector: "a", limit: 10, textLimit: 100, attributes: ["href"] },
    { op: "evaluate", target: TARGET, expression: expr(() => document.title) },
    { op: "evaluate", target: TARGET, expression: "location.origin" },
    { op: "evaluate", target: TARGET, expression: expr(__readMetadata) },
  ];
  let revalidated = 0;
  const results = [];
  for (const step of steps)
    results.push(await tier0Step({ chatId: CHAT, step }, async () => void revalidated++));
  assert.equal(attaches.length, 0, "zero chrome.debugger.attach calls");
  assert.equal(revalidated, steps.length);
  assert.equal(results[0].items[0].text, "Hello");
  assert.equal(results[0].items[0].attributes.href, "/a");
  assert.equal(results[1].value, "Example");
  assert.equal(results[2].value, "https://example.test");
  assert.ok(scripts.every((s) => s.world === "ISOLATED" && s.target.tabId === TAB_ID));
});

test("markdown, text and data plans run in the isolated world", async () => {
  const seen = [];
  runScript = async (options) => {
    seen.push(options);
    return [{ result: options.func === __readMetadata ? { title: "T" } : { ok: true } }];
  };
  const md = await tier0Step(
    {
      chatId: CHAT,
      step: { op: "evaluate", target: TARGET, expression: expr(__readMarkdown, {}) },
    },
    async () => undefined,
  );
  assert.deepEqual(md, { value: { ok: true }, changed: false });
  const data = await tier0Step(
    {
      chatId: CHAT,
      step: {
        op: "evaluate",
        target: TARGET,
        expression:
          "(" + __readPageData + ")(" + __readMetadata + ", " + JSON.stringify({ a: 1 }) + ")",
      },
    },
    async () => undefined,
  );
  assert.deepEqual(data.value, { ok: true });
  assert.equal(seen.at(-1).func, __readPageData);
  assert.deepEqual(seen.at(-1).args, [{ title: "T" }, { a: 1 }], "metadata passed as a value");
  assert.equal(attaches.length, 0);
});

test("page-provenance fetch runs as an isolated-world script on the origin's tab", async () => {
  const seen = [];
  runScript = async (options) => {
    seen.push(options);
    return [{ result: { status: 200, ok: true } }];
  };
  const request = { url: "https://example.test/api/me", credentials: "include" };
  const result = await tier0Step(
    {
      chatId: CHAT,
      step: { op: "evaluate", target: TARGET, expression: expr(__pageRequest, request) },
    },
    async () => undefined,
  );
  assert.equal(result.value.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].func, __pageRequest);
  assert.equal(seen[0].world, "ISOLATED");
  assert.deepEqual(seen[0].target, { tabId: TAB_ID, frameIds: [0] });
  assert.deepEqual(seen[0].args, [request]);
  assert.equal(attaches.length, 0);
});

test("a restricted page or a failed script falls back to CDP", async () => {
  runScript = async () => {
    throw new Error("Cannot access contents of the page");
  };
  const step = { op: "evaluate", target: TARGET, expression: expr(__readMarkdown, {}) };
  assert.equal(await tier0Step({ chatId: CHAT, step }, async () => undefined), undefined);
});

test("shadow DOM traversal uses openOrClosedShadowRoot and the 2.5 s slow-frame cap", async (t) => {
  const inner = fakeRoot([fakeElement("closed")], (els) => els);
  const host = fakeElement("host", {}, [], inner);
  globalThis.document = fakeRoot([host], () => []);
  const read = extractDeep("x", 10, 100, [], SLOW_FRAME_MS);
  assert.equal(read.count, 1);
  assert.equal(read.items[0].text, "closed", "a closed shadow root is read");
  assert.equal(SLOW_FRAME_MS, 2500);
  // A tree slower than the cap stops and says partial.
  let now = 0;
  t.mock.method(Date, "now", () => (now += 3000));
  const slow = extractDeep("x", 10, 100, [], SLOW_FRAME_MS);
  assert.equal(slow.partial, true);
  t.mock.restoreAll();
  // A frame that never answers is cut at the cap and goes to CDP.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  runScript = () => new Promise(() => undefined);
  const pending = runTier0(TAB_ID, tier0Plan(expr(__readMarkdown, {})));
  t.mock.timers.tick(SLOW_FRAME_MS - 1);
  let settled = false;
  void pending.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(2);
  assert.equal(await pending, undefined);
  t.mock.timers.reset();
});

test("a mutating run attaches once and detaches at run end + 20 s", async (t) => {
  const {
    beginBrowserRun,
    endBrowserRun,
    withBrowserDebugger,
    bindBrowserSession,
    RUN_END_DETACH_MS,
  } = session0;
  assert.equal(RUN_END_DETACH_MS, 20_000);
  bindBrowserSession(TAB_ID, CHAT);
  beginBrowserRun(CHAT);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (let step = 0; step < 3; step++) {
    await withBrowserDebugger(TAB_ID, async () => "clicked");
    t.mock.timers.tick(120_000); // a long pause mid-run
  }
  assert.equal(attaches.length, 1, "attached once for the run");
  assert.equal(detaches.length, 0, "no mid-run detach");
  endBrowserRun(CHAT);
  t.mock.timers.tick(RUN_END_DETACH_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detaches.length, 0);
  t.mock.timers.tick(2);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detaches.length, 1, "detached 20 s after the run ended");
  t.mock.timers.reset();
});
