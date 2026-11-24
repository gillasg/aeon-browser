// Round 3 claws: the 60 s network ring, the framework inspector and its scrubbing, checkout and coupon
// detection, dialog auto-handling and teardown, clipboard, workers and the WASM tap, all against plain
// descriptors, a fake DOM and a fake browser: no Chrome, no model.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserRound3ClawsApi } from "../dist/code-api-round3-claws.js";
import {
  ringCreate,
  ringPush,
  ringQuery,
  ringScrub,
} from "../dist/native-browser-ring-recorder.js";
import {
  frameworkScript,
  hydrationWarningsOf,
  scrubDeep,
} from "../dist/native-browser-framework.js";
import {
  checkoutCollect,
  checkoutOf,
  dialogDecision,
  wasmTapInstall,
  wasmTapList,
  wasmTapRemove,
  workersOf,
} from "../dist/native-browser-round3.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("the ring keeps only the last windowMs and at most maxEntries, scrubbed", () => {
  const ring = ringCreate({ windowMs: 60_000, maxEntries: 3 });
  ringPush(
    ring,
    {
      id: "1",
      method: "post",
      url: "https://a.test/login?token=abc",
      preview: '{"password":"hunter2","q":1}',
    },
    0,
  );
  ringPush(ring, { id: "1", status: 200 }, 10);
  assert.deepEqual(plain(ringQuery(ring, {}, 10)), [
    {
      at: 0,
      id: "1",
      method: "POST",
      url: "https://a.test/login?token=%5Bredacted%5D",
      status: 200,
      preview: '{"password":[redacted],"q":1}',
    },
  ]);
  ringPush(ring, { id: "2", url: "https://a.test/b" }, 30_000);
  assert.equal(
    ringQuery(ring, {}, 60_001).length,
    1,
    "the first entry fell out of the 60 s window",
  );
  for (const id of ["3", "4", "5", "6"])
    ringPush(ring, { id, url: "https://a.test/" + id }, 40_000);
  assert.deepEqual(
    ringQuery(ring, {}, 40_000).map((e) => e.id),
    ["4", "5", "6"],
  );
  assert.deepEqual(
    ringQuery(ring, { url: "/5" }, 40_000).map((e) => e.id),
    ["5"],
  );
  assert.deepEqual(ringQuery(ring, { sinceMs: 1 }, 40_000).length, 3);
  assert.deepEqual(ringQuery(ring, {}, 200_000), []);
  assert.doesNotMatch(ringScrub("Authorization: Bearer abcdefghijk"), /abcdefghijk/);
  assert.equal(ringScrub("x Bearer abcdefghijk"), "x Bearer [redacted]");
  assert.match(ringScrub("card 4111 1111 1111 1111"), /redacted-number/);
});

function fakeDom(elements, extra = {}) {
  return {
    window: { ...extra },
    document: {
      querySelectorAll: (selector) => (selector === "*" ? elements : []),
      querySelector: () => null,
      getElementById: (id) => extra.byId?.[id] ?? null,
    },
  };
}

test("frameworkScript finds React components and Next.js, and scrubDeep hides secrets", () => {
  const leaf = {
    type: { name: "Login" },
    memoizedProps: { email: "a@b.c", apiKey: "k-123", onClick() {} },
    memoizedState: { memoizedState: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijk", next: null },
  };
  const root = {
    type: null,
    child: { type: { displayName: "App" }, memoizedProps: {}, memoizedState: null, child: leaf },
  };
  leaf.return = root.child;
  root.child.return = root;
  const host = { getAttribute: () => "", __reactFiber$x1: leaf };
  const next = { textContent: JSON.stringify({ page: "/login", buildId: "b1" }) };
  const raw = vm.runInNewContext(
    frameworkScript({ maxDepth: 5 }),
    fakeDom([host], { byId: { __NEXT_DATA__: next } }),
  );
  assert.deepEqual(plain(raw.frameworks.map((f) => f.name)), ["react", "next"]);
  assert.equal(raw.frameworks[1].page, "/login");
  assert.deepEqual(plain(raw.components.map((c) => c.name)), ["App", "Login"]);
  const scrubbed = scrubDeep(raw);
  const login = scrubbed.components[1];
  assert.equal(login.props.apiKey, "[redacted]");
  assert.equal(login.props.onClick, "[fn]");
  assert.equal(login.state, "[redacted]");
  assert.equal(login.props.email, "a@b.c");
  const none = vm.runInNewContext(frameworkScript(), fakeDom([{ getAttribute: () => "" }]));
  assert.deepEqual(plain(none.frameworks), []);
  const vue = vm.runInNewContext(
    frameworkScript(),
    fakeDom([
      {
        getAttribute: () => "",
        __vue_app__: {
          version: "3.4.0",
          _instance: {
            type: { name: "Root" },
            props: { token: "x" },
            subTree: { component: { type: { __name: "Child" } } },
          },
        },
      },
    ]),
  );
  assert.deepEqual(plain(vue.components.map((c) => c.name)), ["Root", "Child"]);
  assert.equal(scrubDeep(vue).components[0].props.token, "[redacted]");
  const svelte = vm.runInNewContext(
    frameworkScript(),
    fakeDom([{ getAttribute: () => "svelte-abc123 x" }]),
  );
  assert.equal(svelte.frameworks[0].name, "svelte");
  assert.deepEqual(
    hydrationWarningsOf(["ok", "Warning: Text content did not match. Server: a Client: b"]).length,
    1,
  );
});

test("checkout detection finds coupon, amounts and payment markers and never reads values", () => {
  const result = checkoutOf({
    url: "https://shop.test/checkout",
    fields: [
      { name: "promo_code", type: "text", autocomplete: "", label: "Promo code" },
      { name: "cardnumber", type: "text", autocomplete: "cc-number", label: "Card number" },
      { name: "cvc", type: "text", autocomplete: "cc-csc", label: "CVC" },
      { name: "email", type: "email", autocomplete: "email", label: "Email" },
    ],
    buttons: ["Apply", "Place order"],
    lines: ["Subtotal $40.00", "Shipping $5.00", "Tax $3.20", "Total $48.20", "Payment method"],
  });
  assert.deepEqual(plain(result), {
    isCheckout: true,
    amounts: { subtotal: "$40.00", shipping: "$5.00", tax: "$3.20", total: "$48.20" },
    payment: { fields: ["cardnumber", "cvc"], markers: ["Place order", "Payment method"] },
    step: "payment",
    coupon: { field: "promo_code", apply: "Apply" },
  });
  assert.equal(
    checkoutOf({ url: "https://blog.test/", fields: [], buttons: ["Read more"], lines: ["Hello"] })
      .isCheckout,
    false,
  );
  const card = {
    name: "cc",
    id: "",
    type: "text",
    value: "4111111111111111",
    placeholder: "",
    tagName: "INPUT",
    labels: [],
    getAttribute: () => "cc-number",
  };
  const dom = {
    location: { href: "https://shop.test/pay" },
    document: {
      body: { innerText: "Total $1" },
      querySelectorAll: (s) => (s.startsWith("input") ? [card] : []),
    },
  };
  const raw = vm.runInNewContext("(" + checkoutCollect.toString() + ")()", dom);
  assert.ok(!JSON.stringify(raw).includes("4111"), "card values never leave the page");
});

test("dialog decisions follow the policy and workers are filtered to the origin", () => {
  assert.deepEqual(
    dialogDecision({ action: "accept", promptText: "yes" }, { type: "prompt", message: "Name?" }),
    { accept: true, promptText: "yes" },
  );
  assert.deepEqual(dialogDecision({ action: "dismiss" }, { type: "confirm" }), { accept: false });
  assert.deepEqual(
    dialogDecision({ action: "accept", match: "leave" }, { type: "confirm", message: "Stay?" }),
    { accept: false },
  );
  assert.deepEqual(dialogDecision({ action: "accept" }, { type: "beforeunload" }), {
    accept: true,
  });
  const infos = [
    { targetId: "w1", type: "worker", url: "https://a.test/w.js" },
    { targetId: "s1", type: "service_worker", url: "https://a.test/sw.js" },
    { targetId: "x", type: "worker", url: "https://other.test/w.js" },
    { targetId: "p", type: "page", url: "https://a.test/" },
  ];
  assert.deepEqual(
    workersOf(infos, "https://a.test").map((w) => w.targetId),
    ["w1", "s1"],
  );
});

test("the WASM tap records modules only after start and restores the originals on stop", async () => {
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 7, 1, 3, 109, 101, 109, 2, 0,
  ]);
  const context = vm.createContext({ WebAssembly, Date });
  context.window = context;
  const original = WebAssembly.instantiate;
  const run = (fn) => vm.runInContext("(" + fn.toString() + ")()", context);
  assert.deepEqual(plain(run(wasmTapList)), []);
  run(wasmTapInstall);
  await vm.runInContext("WebAssembly.instantiate", context)(bytes);
  assert.deepEqual(plain(run(wasmTapList).map((m) => [m.source, m.exports, m.memoryPages])), [
    ["bytes", ["mem"], 1],
  ]);
  assert.deepEqual(plain(run(wasmTapRemove)), { removed: true });
  assert.equal(WebAssembly.instantiate, original);
});

function sandbox() {
  const cdp = [];
  const streams = [];
  const legacy = [];
  const clip = { text: "", html: "" };
  const page = {
    inspect: async (fn, arg) => {
      const source = typeof fn === "string" ? fn : fn.toString();
      if (/location\.origin/.test(source) && source.length < 40) return "https://a.test";
      if (/clipboard\.read\(\)/.test(source))
        return { ok: true, text: "token=abc123 hi", html: "<b>hi</b>" };
      if (/clipboard\.write/.test(source)) return (Object.assign(clip, arg), { ok: true });
      if (/frameworks/.test(source))
        return {
          frameworks: [{ name: "react" }],
          components: [{ name: "A", props: { password: "p" } }],
          hydration: [],
        };
      if (/checkoutCollect/.test(source))
        return {
          url: "https://a.test/cart",
          fields: [],
          buttons: ["Checkout"],
          lines: ["Total $9.99"],
        };
      return {};
    },
    cdp: async (method, params) => {
      cdp.push([method, params]);
      return method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "w", type: "worker", url: "https://a.test/w.js" }] }
        : {};
    },
    console: async () => [
      { text: "Hydration failed because the server rendered HTML didn't match" },
    ],
  };
  const context = vm.createContext({
    browser: { page: () => page },
    __key: (target) => String(target),
    __cdpStream: (target, event, handler) => {
      const stream = {
        event,
        handler,
        stopped: false,
        ready: Promise.resolve(),
        stop: async () => {
          stream.stopped = true;
        },
      };
      streams.push(stream);
      return stream;
    },
    URL,
    Date,
  });
  vm.runInContext(browserRound3ClawsApi, context);
  const base = { dialogs: async (...args) => (legacy.push(args), { legacy: true }) };
  const extended = vm.runInContext("__extendPageRound3", context)("t1", base);
  return { page: extended, cdp, streams, legacy, clip };
}

test("extending the page costs nothing until a claw is called", () => {
  const { page, cdp, streams } = sandbox();
  for (const name of [
    "ringNetwork",
    "framework",
    "checkout",
    "dialogs",
    "clipboard",
    "workers",
    "wasm",
  ])
    assert.ok(page[name], name);
  assert.equal(cdp.length, 0);
  assert.equal(streams.length, 0);
});

test("ringNetwork subscribes on start, records, and tears down on stop", async () => {
  const { page, streams } = sandbox();
  await assert.rejects(async () => page.ringNetwork.recent(), /start\(\) first/);
  assert.equal((await page.ringNetwork.start({ windowMs: 60_000 })).started, true);
  assert.equal(
    (await page.ringNetwork.start()).started,
    false,
    "a second start does not double-subscribe",
  );
  assert.equal(streams.length, 3);
  streams[0].handler({
    requestId: "r1",
    request: { method: "GET", url: "https://a.test/api" },
    type: "Fetch",
  });
  streams[1].handler({ requestId: "r1", response: { url: "https://a.test/api", status: 404 } });
  assert.deepEqual(plain(page.ringNetwork.recent({ status: 404 }).map((e) => e.id)), ["r1"]);
  assert.deepEqual(plain(page.ringNetwork.clear()), { cleared: true });
  assert.equal(page.ringNetwork.recent().length, 0);
  assert.equal((await page.ringNetwork.stop()).stopped, true);
  assert.ok(streams.every((s) => s.stopped));
});

test("dialogs.auto answers dialogs, logs them scrubbed, keeps the old page.dialogs, and stops cleanly", async () => {
  const { page, cdp, streams, legacy } = sandbox();
  await page.dialogs("dismiss");
  assert.deepEqual(legacy, [["dismiss"]]);
  await assert.rejects(page.dialogs.auto({ action: "maybe" }), /INVALID_INPUT/);
  await page.dialogs.auto({ action: "accept", promptText: "ok" });
  await streams[0].handler({ type: "prompt", message: "Your token=abc123 ?" });
  assert.deepEqual(plain(cdp.at(-1)), [
    "Page.handleJavaScriptDialog",
    { accept: true, promptText: "ok" },
  ]);
  await page.dialogs.auto({ action: "dismiss" });
  assert.equal(streams.length, 1, "changing the policy reuses the listener");
  await streams[0].handler({ type: "confirm", message: "Leave?" });
  assert.deepEqual(plain(cdp.at(-1)), ["Page.handleJavaScriptDialog", { accept: false }]);
  const history = page.dialogs.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].message, "Your token=[redacted] ?");
  assert.deepEqual(plain(await page.dialogs.stop()), { stopped: true, handled: 2 });
  assert.equal(streams[0].stopped, true);
  assert.deepEqual(plain(page.dialogs.history()), []);
});

test("framework, checkout, clipboard and workers go through the page lazily and scrub", async () => {
  const { page, clip } = sandbox();
  const fw = await page.framework.inspect();
  assert.equal(fw.components[0].props.password, "[redacted]");
  assert.equal(fw.hydration.length, 1);
  const read = await page.clipboard.read();
  assert.equal(read.permitted, true);
  assert.equal(read.text, "token=[redacted] hi");
  assert.deepEqual(plain(await page.clipboard.write({ text: "a", html: "<i>a</i>" })), {
    written: true,
    html: true,
  });
  assert.equal(clip.html, "<i>a</i>");
  await assert.rejects(page.clipboard.write({}), /INVALID_INPUT/);
  assert.deepEqual(plain((await page.workers.list()).map((w) => w.targetId)), ["w"]);
  assert.deepEqual(plain(await page.checkout.detect()).amounts, { total: "$9.99" });
});
