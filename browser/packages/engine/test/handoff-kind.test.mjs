// bu.handoff(message, {kind, actionLabel}): a cliff-edge hand-off (pay, send, submit, delete)
// tells the cursor and the ask what it is for, returns when the user approves or cancels, and a
// plain bu.handoff(message) is exactly what it was.
import assert from "node:assert/strict";
import test from "node:test";
import { handoffMeta, HANDOFF_KINDS } from "@browserkit/protocol";

const evaluated = [];
const asks = [];
const notifications = [];
const messageListeners = [];

globalThis.chrome = {
  runtime: {
    id: "ext",
    getURL: (path) => path,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener() {} },
  },
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      if (method === "Runtime.evaluate") evaluated.push(String(params?.expression ?? ""));
      return { result: { value: true } };
    },
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async (id) => ({ id, windowId: 1, active: true, discarded: false, status: "complete" }),
    update: async () => undefined,
    onRemoved: { addListener() {} },
    onReplaced: { addListener() {} },
    onActivated: { addListener() {} },
  },
  windows: { get: async () => ({ focused: true, state: "normal" }), update: async () => undefined },
  scripting: {
    executeScript: async (details) => {
      asks.push(details);
      // The cursor paints in the isolated world; its update travels as the injected args.
      if (details.world === "ISOLATED" && details.args) {
        evaluated.push(JSON.stringify(details.args[0]));
        return [{ result: true }];
      }
      return [];
    },
  },
  notifications: {
    create: async (id, options) => {
      notifications.push(options);
    },
    clear: async () => undefined,
    onClicked: { addListener() {} },
  },
  webNavigation: { onCommitted: { addListener() {}, removeListener() {} } },
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
};

const { handOffToUser } = await import("../dist/native-browser-handoff.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
// The hand-off's answer listener is installed with the engine; a listener the stub lacks an API
// for throws at the end of the install and does not stop the rest.
try {
  installEngineListeners();
} catch {}
assert.ok(messageListeners.length > 0, "the hand-off answer listener is installed");

function answer(tabId, value) {
  for (const listener of messageListeners)
    listener({ kind: "graft.handoff.answer", tabId, answer: value }, { id: "ext" });
}

test("a kind and an action label are kept, and an unknown kind is refused", () => {
  assert.deepEqual(HANDOFF_KINDS, ["auth", "captcha", "cliff-edge"]);
  assert.deepEqual(handoffMeta({}), {});
  assert.deepEqual(handoffMeta({ kind: "cliff-edge", actionLabel: "  Pay $42.10 " }), {
    kind: "cliff-edge",
    actionLabel: "Pay $42.10",
  });
  assert.deepEqual(handoffMeta({ kind: "captcha" }), { kind: "captcha" });
  assert.equal(handoffMeta({ actionLabel: "x".repeat(100) }).actionLabel.length, 40);
  assert.throws(() => handoffMeta({ kind: "payment" }), /INVALID_INPUT.*auth, captcha, cliff-edge/);
});

test("a cliff-edge hand-off marks the cursor, names the button, and returns on approval", async () => {
  evaluated.length = 0;
  asks.length = 0;
  notifications.length = 0;
  const wait = handOffToUser(77, "Pay $42.10 to Acme?", () => true, undefined, {
    kind: "cliff-edge",
    actionLabel: "Pay $42.10",
  });
  setTimeout(() => answer(77, "done"), 50);
  assert.equal(await wait, "done");
  const cursor = evaluated.find((code) => code.includes("needsKind"));
  assert.ok(cursor, "the cursor update carries the kind");
  assert.match(cursor, /"needsKind":"cliff-edge"/);
  assert.match(cursor, /"needsAction":"Pay \$42\.10"/);
  const ask = asks.find((details) => details.args?.[0]?.confirm);
  assert.equal(ask.args[0].confirm, "Pay $42.10");
});

test("cancelling a cliff-edge hand-off returns cancelled", async () => {
  const wait = handOffToUser(78, "Delete 3 files?", () => true, undefined, {
    kind: "cliff-edge",
    actionLabel: "Delete",
  });
  setTimeout(() => answer(78, "cancelled"), 50);
  assert.equal(await wait, "cancelled");
});

test("a plain hand-off carries no kind and keeps the Done button", async () => {
  evaluated.length = 0;
  asks.length = 0;
  const wait = handOffToUser(79, "Please sign in", () => true);
  setTimeout(() => answer(79, "done"), 50);
  assert.equal(await wait, "done");
  const cursor = evaluated.find((code) => code.includes("Please sign in"));
  assert.ok(cursor);
  assert.doesNotMatch(cursor, /"needsKind":"(auth|captcha|cliff-edge)"/);
  assert.ok(asks.every((details) => !details.args?.[0]?.confirm));
});
