import assert from "node:assert/strict";
import test from "node:test";

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListeners: () => listeners.size > 0,
    fire: (...args) => [...listeners].forEach((fn) => fn(...args)),
  };
}
const open = new Set([1, 2, 3, 4, 5]);
const onMessage = event();
const onRemoved = event();
globalThis.chrome = {
  runtime: {
    id: "self",
    onMessage,
    onInstalled: event(),
    onStartup: event(),
    getURL: (path) => "chrome-extension://self/" + path,
    getContexts: async () => [],
    sendMessage: async () => undefined,
  },
  tabs: {
    get: async (tabId) => {
      if (!open.has(tabId)) throw new Error("No tab with id " + tabId);
      return { id: tabId, windowId: 1, active: true, url: "https://login.test/" };
    },
    update: async () => ({}),
    query: async () => [],
    onRemoved,
    onUpdated: event(),
    onActivated: event(),
    onReplaced: event(),
    onCreated: event(),
  },
  windows: {
    get: async () => ({ id: 1, focused: true, state: "normal" }),
    update: async () => ({}),
    onFocusChanged: event(),
    onRemoved: event(),
  },
  notifications: { create: async () => "", clear: async () => true, onClicked: event() },
  webNavigation: { onCommitted: event() },
  debugger: { sendCommand: async () => ({}), onEvent: event(), onDetach: event() },
  scripting: { executeScript: async () => [] },
  action: {
    setBadgeText: async () => {},
    setTitle: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: event(),
  },
};

const { handOffToUser, handoffFor } = await import("../dist/native-browser-handoff.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
const { handoffStatusLine, clipHandoffMessage, elapsedLabel } =
  await import("../../protocol/dist/index.js");
try {
  installEngineListeners();
} catch {
  // Listeners for APIs this stub lacks may throw; the hand-off ones are installed.
}

async function pendingSoon(tabId) {
  for (let i = 0; i < 100 && !handoffFor(tabId); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(handoffFor(tabId), "pending while waiting");
}

test("continue: the user's done clears the record", async () => {
  const run = handOffToUser(1, "Sign in to continue", () => true);
  await pendingSoon(1);
  assert.equal(handoffFor(1).message, "Sign in to continue");
  assert.equal(typeof handoffFor(1).startedAt, "number");
  onMessage.fire({ kind: "graft.handoff.answer", tabId: 1, answer: "done" }, { id: "self" });
  assert.equal(await run, "done");
  assert.equal(handoffFor(1), undefined);
});

test("cancel: Skip or a stopped chat clears the record", async () => {
  const run = handOffToUser(2, "Pick a plan", () => true);
  await pendingSoon(2);
  onMessage.fire({ kind: "graft.handoff.answer", tabId: 2, answer: "cancelled" }, { id: "self" });
  assert.equal(await run, "cancelled");
  assert.equal(handoffFor(2), undefined);
  let live = true;
  const stopped = handOffToUser(5, "Approve", () => live);
  await pendingSoon(5);
  live = false;
  assert.equal(await stopped, "cancelled");
  assert.equal(handoffFor(5), undefined);
});

test("timeout: the hand-off deadline clears the record", async () => {
  const realNow = Date.now;
  const run = handOffToUser(3, "Solve the check", () => true);
  await pendingSoon(3);
  Date.now = () => realNow() + 31 * 60_000;
  try {
    assert.equal(await run, "cancelled");
  } finally {
    Date.now = realNow;
  }
  assert.equal(handoffFor(3), undefined);
});

test("tab close: closing the tab ends the hand-off as cancelled", async () => {
  const run = handOffToUser(4, "Enter the code", () => true);
  await pendingSoon(4);
  open.delete(4);
  onRemoved.fire(4, {});
  assert.equal(handoffFor(4), undefined);
  assert.equal(await run, "cancelled");
  assert.equal(handoffFor(4), undefined);
});

test("one status line wording, clipped to 80 characters", () => {
  assert.equal(elapsedLabel(130_000), "2m 10s");
  assert.equal(elapsedLabel(45_000), "45s");
  assert.equal(
    handoffStatusLine({ message: "Sign in to continue", startedAt: 0 }, 130_000),
    "Waiting on you: Sign in to continue (2m 10s)",
  );
  assert.equal(clipHandoffMessage("x".repeat(200)).length, 80);
});

test("the tab list and the inventory row carry the pending hand-off", async () => {
  const { tabStatus } = await import("../dist/native-browser-tabs.js");
  const { toInventoryTab } = await import("../dist/native-inventory-client.js");
  const run = handOffToUser(1, "Confirm the transfer", () => true);
  await pendingSoon(1);
  assert.equal(tabStatus(1).handoff.message, "Confirm the transfer");
  const row = toInventoryTab(
    {
      id: 1,
      windowId: 1,
      index: 0,
      url: "https://bank.test/",
      title: "Bank",
      active: true,
      pinned: false,
      status: "complete",
    },
    {
      clientInstanceId: "11111111-1111-4111-8111-111111111111",
      browserRunId: "22222222-2222-4222-8222-222222222222",
    },
    { tabIncarnation: "33333333-3333-4333-8333-333333333333", documentEpoch: 0 },
  );
  assert.equal(row.handoff.message, "Confirm the transfer");
  onMessage.fire({ kind: "graft.handoff.answer", tabId: 1, answer: "done" }, { id: "self" });
  await run;
  assert.equal(tabStatus(1).handoff, undefined);
});
