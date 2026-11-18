// A parallel chat must never make a browser_code cell wait on another chat's tab, and a cell's
// timeout must not cost the chat the tabs it opened.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const KEY_A = {
  clientInstanceId: "11111111-1111-4111-8111-111111111111",
  browserRunId: "22222222-2222-4222-8222-222222222222",
  tabId: 111,
  tabIncarnation: "33333333-3333-4333-8333-333333333333",
};
const KEY_B = { ...KEY_A, tabId: 112 };

function tab(target, overrides = {}) {
  return {
    target,
    windowId: 1,
    index: 0,
    url: "https://example.test/",
    title: "Example",
    status: "complete",
    active: true,
    pinned: false,
    groupId: -1,
    documentEpoch: 1,
    ...overrides,
  };
}

const sandbox = readFileSync(new URL("../src/code-sandbox.ts", import.meta.url), "utf8");

async function sandboxSource() {
  const from = new Map();
  for (const match of sandbox.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)\.js";/g)) {
    for (const name of match[1].split(",").map((part) => part.trim()))
      if (name) from.set(name, match[2]);
  }
  const list = /evaluate\(\s*\[([\s\S]*?)\]\.join/.exec(sandbox);
  assert.ok(list, "code-sandbox.ts evaluates the runtime parts");
  const parts = [];
  for (const name of list[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const file = from.get(name);
    assert.ok(file, `${name} is imported from a local module`);
    const module = await import(new URL(`../dist/${file}.js`, import.meta.url));
    assert.equal(typeof module[name], "string", `${name} is runtime source`);
    parts.push(module[name]);
  }
  return parts.join("\n");
}

function realm(source, tabs) {
  const calls = [];
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  };
  vm.createContext(context);
  context.globalThis = context;
  context.window = context;
  context.__call = async (request) => {
    calls.push(request);
    if (request?.op === "listTabs") return { kind: "tabs", focusedWindowId: 1, tabs };
    if (request?.op === "attachTab") return { kind: "tab", tab: tabs[0] };
    if (request?.op === "evaluate") return { data: { value: 1, changed: false } };
    return {};
  };
  vm.runInContext(source, context, { filename: "sandbox.js" });
  return {
    async activeTab() {
      return vm.runInContext("browser.activeTab()", context);
    },
  };
}

test("activeTab never returns a tab another chat is driving", async () => {
  const source = await sandboxSource();
  // The engine marks the borrowed tab before listing it; a listed tab with heldByOther is off
  // limits for default-tab picks even when it is the active tab of the focused window.
  const mine = tab(KEY_A, { title: "Mine" });
  const listed = [tab(KEY_B, { title: "Lane A", heldByOther: true }), mine];
  const box = realm(source, listed);
  const picked = await box.activeTab();
  assert.equal(picked.id, KEY_A.tabId);
  assert.equal(picked.title, "Mine");
});

test("activeTab still finds the user's active tab when no chat holds one", async () => {
  const source = await sandboxSource();
  const box = realm(source, [tab(KEY_A), tab(KEY_B, { active: false })]);
  const picked = await box.activeTab();
  assert.equal(picked.id, KEY_A.tabId);
});

test("a tab queue wait is bounded and a timed-out waiter never runs its work", async () => {
  const { inTabQueue, setLockWaitMs } = await import("../dist/native-browser-scheduler.js");
  setLockWaitMs(60);
  let release = () => undefined;
  try {
    const holder = inTabQueue(77, () => new Promise((done) => (release = done)));
    let ran = false;
    await assert.rejects(
      inTabQueue(77, async () => {
        ran = true;
      }),
      /TAB_BUSY: tab 77 is busy/,
    );
    assert.equal(ran, false);
    release();
    await holder;
  } finally {
    setLockWaitMs(30_000);
  }
});

test("a timed-out cell keeps its opened tabs with the chat for the normal tidy", async () => {
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
      session: undefined,
    },
    tabs: {
      get: async (id) => (id === 88 ? tab(KEY_A, { tabId: 88 }) : undefined),
      query: async () => [],
      remove: async () => undefined,
      update: async () => undefined,
    },
    windows: { getLastFocused: async () => ({ id: 1, focused: true }) },
    alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    runtime: {
      onMessage: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
    },
    action: { setBadgeText: async () => undefined, setTitle: async () => undefined },
    tabGroups: { TAB_GROUP_ID_NONE: -1 },
  };
  const { keepAgentTabs, tidyChatTabs } = await import("../dist/native-browser-tab-cleanup.js");
  keepAgentTabs("chat-1", [{ tabId: 88 }]);
  // The tab is still live and belongs to chat-1; the end-of-run tidy keeps exactly one tab.
  const closed = await tidyChatTabs("chat-1");
  assert.deepEqual(closed, []);
});

test("a failed cell keeps only tabs it opened, never a tab it attached to", async () => {
  const { keepStepsTabs, isAgentTab } = await import("../dist/native-browser-tab-cleanup.js");
  const tab = (tabId) => ({ kind: "tab", tab: { target: { tabId } } });
  keepStepsTabs("chat-2", [
    { action: { op: "openTab" }, result: tab(501) },
    { action: { op: "attachTab" }, result: tab(502) },
  ]);
  assert.equal(isAgentTab(501), true);
  // The attached tab is the user's: the tidy must never treat it as the chat's.
  assert.equal(isAgentTab(502), false);
});

test("the final observation has its own deadline in the sandbox", () => {
  assert.match(sandbox, /bounded\(evaluate\("__finishCell\(\)"\), 5000\)/);
});

test("cross-chat steps fail before any queue, and listTabs marks another chat's tab", async () => {
  const executor = readFileSync(
    new URL("../src/native-browser-executor.ts", import.meta.url),
    "utf8",
  );
  const tabs = readFileSync(new URL("../src/native-browser-tabs.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/code-runtime-host.ts", import.meta.url), "utf8");
  const check = executor.indexOf("browserSessionHolder(step.target.tabId)");
  const queue = executor.indexOf("return scheduleStep(");
  assert.ok(check > 0 && check < queue, "a foreign tab gets a shorter queue budget");
  assert.match(executor, /holder !== request\.chatId \? 5000 : undefined/);
  assert.match(tabs, /heldByOther:[\s\S]*?holder !== request\.chatId/);
  assert.match(host, /if \(result\.error\) keepStepsTabs\(/);
});
