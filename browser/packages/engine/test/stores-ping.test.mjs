import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  debugger: {
    sendCommand: async () => ({}),
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: { get: async () => ({}), onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, id: "x" },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
};

const { storesCollectForTest: collect, storesScript } =
  await import("../dist/native-browser-stores.js");
const { networkRecorderForTest } = await import("../dist/native-browser-network.js");
const { scrubDeep } = await import("../dist/native-browser-framework.js");
const { browserReApi } = await import("../dist/code-api-re.js");

function doc(elements = {}) {
  return {
    getElementById: (id) => elements[id] ?? null,
    querySelector: (css) => elements[css] ?? null,
    body: { firstElementChild: null },
  };
}

function frozen(value) {
  return Object.freeze(value);
}

test("hydration blobs and an Apollo cache are read without touching the page", () => {
  const calls = [];
  const cache = {
    extract() {
      calls.push("extract");
      return { ROOT_QUERY: { me: { __ref: "User:1" } }, "User:1": { name: "Ana" } };
    },
  };
  const w = frozen({
    __NEXT_DATA__: frozen({ props: frozen({ pageProps: frozen({ id: 7 }) }), buildId: "b" }),
    __APOLLO_CLIENT__: frozen({
      cache: frozen(cache),
      mutate() {
        throw new Error("must not be called");
      },
    }),
  });
  const result = collect(w, doc(), {});
  assert.deepEqual(result.kinds.sort(), ["apollo", "next"]);
  const apollo = result.stores.find((s) => s.kind === "apollo");
  assert.equal(apollo.data["User:1"].name, "Ana");
  assert.deepEqual(calls, ["extract"]);
  const slice = collect(w, doc(), { kind: "apollo", path: "/User:1" });
  assert.deepEqual(slice.stores[0].data, { name: "Ana" });
});

test("TanStack Query and Redux stores come from React providers", () => {
  const queryClient = {
    getQueryCache: () => ({
      getAll: () => [
        { queryKey: ["todos"], state: { status: "success", dataUpdatedAt: 5, data: [{ id: 1 }] } },
      ],
    }),
  };
  const store = {
    getState: () => ({ cart: { items: 2 } }),
    dispatch() {
      throw new Error("no dispatch");
    },
    subscribe() {},
  };
  const fiber = {
    memoizedProps: { client: queryClient },
    child: { memoizedProps: { store }, child: null, sibling: null },
    sibling: null,
  };
  const root = { __reactContainer$abc: { stateNode: { current: fiber } } };
  const result = collect({}, doc({ root }), {});
  const tanstack = result.stores.find((s) => s.kind === "tanstack");
  assert.deepEqual(tanstack.data.queries[0].queryKey, ["todos"]);
  assert.equal(result.stores.find((s) => s.kind === "redux").data.cart.items, 2);
});

test("Zustand-shaped window stores, Pinia and Vuex are found; kind filters", () => {
  const zustand = { getState: () => ({ open: true }), setState() {}, subscribe() {} };
  const app = {
    config: {
      globalProperties: {
        $pinia: { state: { value: { user: { id: 3 } } } },
        $store: { state: { n: 1 } },
      },
    },
  };
  const result = collect({ useUi: zustand }, doc({ "[data-v-app]": { __vue_app__: app } }), {});
  assert.deepEqual(result.kinds.sort(), ["pinia", "vuex", "zustand"]);
  assert.deepEqual(collect({ useUi: zustand }, doc(), { kind: "zustand" }).stores[0].data, {
    open: true,
  });
});

test("copies are cycle-safe and bounded, and secrets are scrubbed", () => {
  const state = { token: "abc", list: Array.from({ length: 80 }, (_, i) => i), deep: {} };
  state.self = state;
  let node = state.deep;
  for (let i = 0; i < 20; i++) node = node.next = {};
  const result = collect({ __NUXT__: state }, doc(), { maxKeys: 10, maxDepth: 4 });
  const data = result.stores[0].data;
  assert.equal(data.self, "[cycle]");
  assert.equal(data.list.length, 11);
  assert.match(data.list[10], /more/);
  assert.equal(JSON.stringify(data).includes("[object]"), true, "depth is capped");
  assert.equal(scrubDeep({ token: "abc" }).token, "[redacted]");
  assert.match(browserReApi, /scrubDeep\(raw/);
});

test("the page expression evaluates on its own and defines no globals", () => {
  const before = Object.keys(globalThis).length;
  const w = { __NEXT_DATA__: { props: { a: 1 } } };
  const run = new Function("window", "document", `return ${storesScript({ kind: "next" })};`);
  const result = run(w, doc());
  assert.equal(result.stores[0].data.props.a, 1);
  assert.equal(Object.keys(globalThis).length, before);
  assert.deepEqual(Object.keys(w), ["__NEXT_DATA__"], "the page window is not written to");
});

const request = (requestId, url, type) => ({
  requestId,
  type,
  request: { url, method: "POST", headers: {} },
});

test("sendBeacon pings are captured as their own resource type", () => {
  const net = networkRecorderForTest({ allTypes: false });
  net.event("Network.requestWillBeSent", request("p", "https://a.test/collect", "Ping"));
  net.event("Network.requestWillBeSent", request("i", "https://a.test/x.png", "Image"));
  assert.deepEqual(
    net.entries().map((e) => [e.id ?? e.requestId, e.type]),
    [["p", "Ping"]],
  );
  const passive = networkRecorderForTest({ allTypes: false, passive: true });
  passive.event("Network.requestWillBeSent", request("p2", "https://a.test/api/event", "Ping"));
  assert.equal(passive.entries().length, 1);
});
