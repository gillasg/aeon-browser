import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const delay = {
  "DOM.describeNode": 2,
  "Accessibility.getFullAXTree": 40,
  "Page.getFrameTree": 8,
};

globalThis.chrome = {
  debugger: {
    sendCommand: (_debuggee, method) => {
      calls.push(method);
      const ms = delay[method] ?? 0;
      return new Promise((resolve) =>
        setTimeout(() => {
          if (method === "DOM.describeNode") resolve(calls.describe ?? { node: { nodeId: 1 } });
          else if (method === "Accessibility.getFullAXTree")
            resolve(
              calls.tree ?? { nodes: [{ backendDOMNodeId: 7, role: { value: "button" } }] },
            );
          else resolve({ frameTree: { frame: { id: "root" } } });
        }, ms),
      );
    },
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async (id) => ({ id, active: false, discarded: false, status: "complete" }),
    onRemoved: { addListener() {} },
    onReplaced: { addListener() {} },
    onActivated: { addListener() {} },
    sendMessage: async () => undefined,
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  storage: { session: { get: async () => ({}), set: async () => undefined } },
  runtime: { onInstalled: { addListener() {} }, getURL: (path) => path },
  windows: { get: async () => ({ focused: true, state: "normal" }) },
};

const { resolveElement, clickAt } = await import("../dist/native-browser-debugger.js");
const { humanType } = await import("../dist/native-browser-human-input.js");
const { ensureBrowserAttachment } = await import("../dist/native-browser-session.js");
const { rememberVaultCandidate } = await import("../dist/native-browser-vault.js");
const { configureEngine } = await import("../dist/engine-config.js");

configureEngine({
  agentGlow: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(true),
});

const target = { tabId: 4, clientInstanceId: "00000000-0000-4000-8000-000000000001" };

test("resolving a live node id skips the accessibility tree", async () => {
  calls.length = 0;
  const started = performance.now();
  await resolveElement(
    { tabId: 4 },
    { kind: "backend", backendNodeId: 7, documentEpoch: 1 },
    target,
    new Map(),
    new Map(),
    1,
  );
  const hit = performance.now() - started;
  assert.ok(calls.includes("DOM.describeNode"));
  assert.equal(calls.includes("Accessibility.getFullAXTree"), false);
  calls.describe = {};
  calls.length = 0;
  const treeStarted = performance.now();
  await resolveElement(
    { tabId: 4 },
    { kind: "backend", backendNodeId: 7, documentEpoch: 1 },
    target,
    new Map(),
    new Map(),
    1,
  ).catch(() => undefined);
  const miss = performance.now() - started;
  const tree = performance.now() - treeStarted;
  console.log(
    `resolve hit ${hit.toFixed(1)} ms (describeNode); tree fallback ${tree.toFixed(1)} ms; before path about 48 ms`,
  );
  assert.ok(hit < 30, `hit ${hit}`);
  assert.ok(tree > 40, `tree ${tree}`);
  assert.ok(calls.includes("Accessibility.getFullAXTree"));
  void miss;
  delete calls.tree;
  delete calls.describe;
});

test("a backend id on an ignored node is returned for a click, not dropped as a miss", async () => {
  calls.length = 0;
  calls.describe = {};
  calls.tree = { nodes: [{ backendDOMNodeId: 7, ignored: true }] };
  const ref = await resolveElement(
    { tabId: 4 },
    { kind: "backend", backendNodeId: 7, documentEpoch: 1 },
    target,
    new Map(),
    new Map(),
    1,
  );
  assert.equal(ref.backendNodeId, 7);
  delete calls.tree;
  delete calls.describe;
});

test("a described backend id with an empty box does not walk the accessibility tree", async () => {
  calls.length = 0;
  calls.describe = { node: { backendNodeId: 7 } };
  calls.tree = { nodes: [{ backendDOMNodeId: 7, ignored: true }] };
  const ref = await resolveElement(
    { tabId: 4 },
    { kind: "backend", backendNodeId: 7, documentEpoch: 1 },
    target,
    new Map(),
    new Map(),
    1,
  );
  assert.equal(ref.backendNodeId, 7);
  assert.equal(calls.includes("Accessibility.getFullAXTree"), false);
  delete calls.tree;
  delete calls.describe;
});

test("attach enables the page and leaves the other domains off", async () => {
  calls.length = 0;
  delete calls.describe;
  const started = performance.now();
  await ensureBrowserAttachment(8, "chat");
  const ms = performance.now() - started;
  const attachCalls = calls.filter((method) => method !== "Page.getFrameTree");
  console.log(
    `attach ${attachCalls.length} commands in ${ms.toFixed(1)} ms; before was 6 commands (attach, Page, DOM, Accessibility, focus, Network)`,
  );
  assert.equal(attachCalls.includes("DOM.enable"), false);
  assert.equal(attachCalls.includes("Accessibility.enable"), false);
  assert.equal(attachCalls.includes("Network.enable"), false);
  assert.equal(attachCalls.includes("Emulation.setFocusEmulationEnabled"), false);
  assert.ok(attachCalls.includes("Page.enable"));
});

test("a form field is one insert, under 300 ms", async () => {
  const text = "hunter2-password!";
  const started = performance.now();
  await humanType({ tabId: 4 }, text);
  const ms = performance.now() - started;
  console.log(
    `form fill ${text.length} chars ${ms.toFixed(1)} ms; before at least ${text.length * 75} ms plus up to 1100 ms of pointer travel`,
  );
  assert.ok(ms < 300, `fill ${ms}`);
  assert.ok(calls.includes("Input.insertText"));
});

test("a click after a password fill does not blur in front of the mouse and sends no key", async () => {
  calls.length = 0;
  rememberVaultCandidate(
    4,
    {
      url: "https://example.test/signup",
      site: "example.test",
      hasPassword: true,
      password: "hunter2",
      username: "ada",
      signup: true,
    },
    "agent",
  );
  await clickAt({ tabId: 4 }, 10, 10);
  assert.equal(calls.includes("Runtime.evaluate"), false, calls.join(","));
  assert.equal(calls.includes("Input.dispatchKeyEvent"), false, calls.join(","));
  assert.ok(calls.includes("Input.dispatchMouseEvent"));
});

test("password UI is blurred when the fill is dismissed, and no key is sent", async () => {
  calls.length = 0;
  const { dismissPasswordUi } = await import("../dist/native-browser-vault.js");
  await dismissPasswordUi({ tabId: 4 });
  assert.ok(calls.includes("Runtime.evaluate"), calls.join(","));
  assert.equal(calls.includes("Input.dispatchKeyEvent"), false, calls.join(","));
});
