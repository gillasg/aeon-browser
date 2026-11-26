import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const session = {};
const local = {};
const TAB_ID = 7;
let nodeAtPoint = () => ({ backendNodeId: 42 });
// What the press probe reads back: did the page see the mousedown? Default: always yes.
let probeSeen = () => true;

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
  if (
    method === "Runtime.callFunctionOn" &&
    /requestAnimationFrame/.test(params.functionDeclaration)
  )
    return Promise.resolve({ result: { value: true } });
  if (method === "Runtime.callFunctionOn" && /probe\.rec\.seen/.test(params.functionDeclaration))
    return Promise.resolve({ result: { value: probeSeen() } });
  if (method === "Runtime.callFunctionOn")
    return Promise.resolve({ result: { value: nodeAtPoint(params).backendNodeId === 42 } });
  if (method === "Runtime.evaluate") {
    const expression = String(params?.expression ?? "");
    if (expression.includes("__aeonQuiet")) {
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
    attach: async () => undefined,
    detach: async () => undefined,
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
  runtime: { getURL: (path) => `chrome-extension://aeon/${path}` },
  scripting: { executeScript: async () => [] },
};

class FakeSocket {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((item) => item !== fn),
    );
  }
  send(data) {
    const message = JSON.parse(String(data));
    const reply = {
      kind: "browser.inventory.applied",
      generation: message.generation,
      lastSequence: message.sequence ?? 0,
    };
    queueMicrotask(() => {
      for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(reply) });
    });
  }
  close() {}
}

const { BrowserStepSchema, browserStepWrites } = await import("@browserkit/protocol");
const { clampHoldMs, holdAt, HOLD_DEFAULT_MS, HOLD_MAX_MS } =
  await import("../dist/native-browser-debugger.js");
const { performAction } = await import("../dist/native-browser-input.js");
const { stepChangesPage } = await import("../dist/native-browser-guards.js");
const { labelForAction } = await import("../dist/evidence/label.js");
const { stepEventFrom } = await import("../dist/evidence/step-record.js");
const { bindBrowserSession } = await import("../dist/native-browser-session.js");
const { synchronizeBrowserInventory, currentInventoryTabs } =
  await import("../dist/native-inventory-client.js");
const { browserCodeApi } = await import("../dist/code-api.js");
const { browserFastApi } = await import("../dist/code-api-page.js");

const IDENTITY = {
  clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
  browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
};
const TARGET = {
  ...IDENTITY,
  tabId: 1,
  tabIncarnation: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f9",
};
const CELL = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";

function mice() {
  return calls.filter((call) => call.method === "Input.dispatchMouseEvent");
}

test("press-and-hold", async (t) => {
  await t.test("ms is capped without sleeping the maximum", () => {
    assert.equal(clampHoldMs(undefined), HOLD_DEFAULT_MS);
    assert.equal(clampHoldMs(undefined), 1500);
    assert.equal(HOLD_MAX_MS, 15000);
    assert.equal(clampHoldMs(/** @type {number} */ (null)), 1500);
    assert.equal(clampHoldMs(Number.NaN), 1500);
    assert.equal(clampHoldMs(Number.POSITIVE_INFINITY), 1500);
    assert.equal(clampHoldMs(-5), 0);
    assert.equal(clampHoldMs(40.4), 40);
    assert.equal(clampHoldMs(1e9), 15000);
    const step = BrowserStepSchema.parse({ op: "hold", target: TARGET, x: 1, y: 2, ms: 15000 });
    assert.equal(browserStepWrites(step), true);
    assert.equal(stepChangesPage(step), true);
    assert.throws(() =>
      BrowserStepSchema.parse({ op: "hold", target: TARGET, x: 1, y: 2, ms: 15001 }),
    );
    assert.equal(labelForAction({ op: "hold" }), "Hold");
    const event = stepEventFrom({
      cellId: CELL,
      chatId: CHAT,
      index: 0,
      step: {
        op: "hold",
        element: { role: "button", name: "Confirm", backendNodeId: 4 },
        target: { tabId: 3 },
      },
      entry: {
        tEnd: 10,
        ms: 40,
        result: { effect: "confirmed", url: "https://shop.test/ok", evidence: "held" },
      },
    });
    assert.equal(event?.kind, "click");
    assert.equal(event?.label, "Hold “Confirm”");
    assert.equal(event?.write, true);
    assert.match(browserCodeApi, /holdAt:/);
    assert.match(browserCodeApi, /op:'hold'/);
    assert.match(browserFastApi, /hold: \(id, options\)/);
  });

  await t.test("CDP order is move, press, hold, release on the left button", async () => {
    calls.length = 0;
    await holdAt({ tabId: 3 }, 100, 200, 50);
    const events = mice();
    const types = events.map((event) => event.params.type);
    const press = types.indexOf("mousePressed");
    const release = types.lastIndexOf("mouseReleased");
    assert.ok(
      types.indexOf("mouseMoved") >= 0 && types.indexOf("mouseMoved") < press,
      types.join(),
    );
    assert.ok(release > press, types.join());
    const down = events[press].params;
    const up = events[release].params;
    assert.equal(down.button, "left");
    assert.equal(down.clickCount, 1);
    assert.equal(down.buttons, 1);
    assert.equal(up.button, "left");
    assert.equal(up.clickCount, 1);
    assert.equal(up.buttons, 0);
    assert.equal(up.x, down.x);
    assert.equal(up.y, down.y);
    assert.ok(events[release].at - events[press].at >= 50);
    assert.ok(events[release].at - events[press].at < 15000);
  });

  await t.test(
    "a longer hold jitters between press and release and stays on the point",
    async () => {
      calls.length = 0;
      await holdAt({ tabId: 3 }, 80, 90, 400);
      const events = mice();
      const press = events.findIndex((event) => event.params.type === "mousePressed");
      const release = events.findLastIndex((event) => event.params.type === "mouseReleased");
      const between = events.slice(press + 1, release);
      assert.ok(
        between.some((event) => event.params.type === "mouseMoved"),
        JSON.stringify(between),
      );
      const down = events[press].params;
      for (const event of between) {
        assert.equal(event.params.type, "mouseMoved");
        assert.equal(event.params.button, "left");
        assert.equal(event.params.buttons, 1);
        assert.ok(Math.abs(event.params.x - down.x) <= 1);
        assert.ok(Math.abs(event.params.y - down.y) <= 1);
      }
      assert.equal(events[release].params.x, down.x);
      assert.equal(events[release].params.y, down.y);
      assert.ok(events[release].at - events[press].at >= 400);
      assert.ok(events[release].at - events[press].at < 1500);
    },
  );

  await t.test("holdAt returns the same action receipt as a click", async () => {
    calls.length = 0;
    await synchronizeBrowserInventory(new FakeSocket(), IDENTITY);
    const live = currentInventoryTabs().find((item) => item.target.tabId === TAB_ID);
    assert.ok(live, "inventory tab");
    bindBrowserSession(TAB_ID, CHAT);
    const result = await performAction(
      {
        step: {
          op: "hold",
          target: live.target,
          x: 40,
          y: 50,
          ms: 40,
          observe: false,
        },
      },
      async () => undefined,
    );
    assert.equal(result.kind, "action");
    assert.equal(result.label, "Hold");
    assert.ok(result.receipt);
    assert.equal(result.receipt.navigated, false);
    assert.ok(Array.isArray(result.receipt.popups));
    assert.ok(result.effect);
    assert.match(result.evidence, /hold/);
    const events = mice();
    const types = events.map((event) => event.params.type);
    const press = types.indexOf("mousePressed");
    const release = types.lastIndexOf("mouseReleased");
    assert.ok(press > 0 && release > press);
    assert.ok(events[release].at - events[press].at >= 40);
  });

  const target = {
    debuggee: { tabId: 3 },
    backendNodeId: 42,
    offsetX: 0,
    offsetY: 0,
  };

  await t.test("the press waits until the intended target is under the point", async () => {
    calls.length = 0;
    let checks = 0;
    // A transient overlay sits over the button for the first two landing checks, then clears.
    nodeAtPoint = () => ({ backendNodeId: ++checks < 3 ? 999 : 42 });
    try {
      await holdAt({ tabId: 3 }, 100, 200, 30, target);
    } finally {
      nodeAtPoint = () => ({ backendNodeId: 42 });
    }
    const locations = calls.filter((call) => call.method === "DOM.resolveNode");
    assert.ok(locations.length >= 3, `only ${locations.length} landing checks`);
    const events = mice();
    const press = events.findIndex((event) => event.params.type === "mousePressed");
    const release = events.findLastIndex((event) => event.params.type === "mouseReleased");
    assert.ok(press > 0 && release > press);
    // No press was sent while the overlay was still under the point.
    assert.ok(
      events[press].at >= locations[2].at,
      `press preceded the good landing check: ${events[press].at} < ${locations[2].at}`,
    );
    assert.equal(events[press].params.x, 100);
    assert.equal(events[press].params.y, 200);
  });

  await t.test(
    "a target that never arrives is reported, never pressed and released blind",
    async () => {
      calls.length = 0;
      nodeAtPoint = () => ({ backendNodeId: 999 });
      try {
        await assert.rejects(holdAt({ tabId: 3 }, 100, 200, 30, target), /TARGET_LOST/);
      } finally {
        nodeAtPoint = () => ({ backendNodeId: 42 });
      }
      const events = mice();
      assert.equal(events.filter((event) => event.params.type === "mousePressed").length, 0);
      assert.equal(events.filter((event) => event.params.type === "mouseReleased").length, 0);
    },
  );

  await t.test("a press the page never received is released and sent again", async () => {
    calls.length = 0;
    // The renderer drops the first press (no frame yet); the second one arrives.
    let presses = 0;
    probeSeen = () => presses >= 2;
    const counting = calls.push.bind(calls);
    calls.push = (call) => {
      if (call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")
        presses += 1;
      return counting(call);
    };
    try {
      await holdAt({ tabId: 3 }, 100, 200, 120, target);
    } finally {
      calls.push = counting;
      probeSeen = () => true;
    }
    const events = mice().filter((event) => event.params.type !== "mouseMoved");
    assert.deepEqual(
      events.map((event) => event.params.type),
      ["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"],
    );
    // The dwell counts from the press the page saw, not the dropped one.
    assert.ok(events[3].at - events[2].at >= 120, `${events[3].at - events[2].at} ms`);
  });

  await t.test("a press the page never sees is reported, with the button released", async () => {
    calls.length = 0;
    probeSeen = () => false;
    try {
      await assert.rejects(holdAt({ tabId: 3 }, 100, 200, 30, target), /TARGET_LOST/);
    } finally {
      probeSeen = () => true;
    }
    const types = mice()
      .map((event) => event.params.type)
      .filter((type) => type !== "mouseMoved");
    assert.equal(types.filter((type) => type === "mousePressed").length, 3);
    assert.equal(types.filter((type) => type === "mouseReleased").length, 3);
    assert.equal(types.at(-1), "mouseReleased");
  });
});
