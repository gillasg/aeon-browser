// page.cause(action): the request, store and frame diffs, and the sandbox wrapper against a fake
// page (no Chrome, no model), including the DOM observer cleanup when the action throws.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const load = (name) => import(pathToFileURL(path.join(dist, name)).href);
const { causeDiffRequests, causeDiffStores, causeSliceFrames, causeClass } =
  await load("native-browser-cause.js");
const { browserCauseApi } = await load("code-api-cause.js");
const { browserPosthocNetApi } = await load("code-api-posthoc-net.js");

const plain = (value) => JSON.parse(JSON.stringify(value));

test("query param diff against the latest call of the same endpoint (Luma)", () => {
  const before = [
    {
      id: "1",
      method: "GET",
      url: "https://api.lu.ma/discover/get-paginated-events?pagination_limit=20",
      status: 200,
    },
  ];
  const after = before.concat([
    {
      id: "2",
      method: "GET",
      url: "https://api.lu.ma/discover/get-paginated-events?pagination_limit=20&slug=tech",
      status: 200,
    },
  ]);
  const { requests } = causeDiffRequests(before, after);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "api");
  assert.deepEqual(plain(requests[0].diff), { query: { slug: [null, "tech"] } });
});

test("GraphQL variables diff by op name (AniList)", () => {
  const body = (variables) =>
    JSON.stringify({
      operationName: "SearchAnime",
      query: "query SearchAnime { Page { id } }",
      variables,
    });
  const before = [
    { id: "a", method: "POST", url: "https://graphql.anilist.co/", requestBody: body({ page: 1 }) },
  ];
  const after = before.concat([
    {
      id: "b",
      method: "POST",
      url: "https://graphql.anilist.co/",
      requestBody: body({ page: 1, search: "frieren" }),
    },
  ]);
  const { requests } = causeDiffRequests(before, after, [], []);
  assert.equal(requests[0].kind, "graphql");
  assert.equal(requests[0].op, "SearchAnime");
  assert.deepEqual(plain(requests[0].diff), { variables: { search: [null, "frieren"] } });
});

test("JSON POST body diff and noise counted apart (Bandcamp)", () => {
  const before = [
    {
      id: "1",
      method: "POST",
      url: "https://bandcamp.com/api/hub/2/dig_deeper",
      requestBody: JSON.stringify({ tag: "all", page: 1 }),
    },
  ];
  const after = before.concat([
    { id: "2", method: "POST", url: "https://www.google-analytics.com/g/collect?v=2" },
    { id: "3", method: "GET", url: "https://f4.bcbits.com/img/a1_2.jpg", type: "Image" },
    { id: "4", method: "GET", url: "https://bandcamp.com/cdn-cgi/challenge-platform/h/b/jsd" },
    { id: "5", method: "POST", url: "https://bandcamp.com/rum", type: "Ping" },
    {
      id: "6",
      method: "POST",
      url: "https://bandcamp.com/api/hub/2/dig_deeper",
      requestBody: JSON.stringify({ tag: "ambient", page: 1 }),
      status: 200,
    },
  ]);
  const { requests, noise } = causeDiffRequests(before, after);
  assert.deepEqual(
    requests.map((r) => r.id),
    ["6"],
  );
  assert.deepEqual(plain(requests[0].diff), { body: { tag: ["all", "ambient"] } });
  assert.equal(noise.tracker, 1);
  assert.equal(noise.media, 1);
  assert.equal(noise.challenge, 1);
  assert.equal(noise.beacon, 1);
});

test("a recorded entry.class wins over the inline guess", () => {
  assert.equal(causeClass({ url: "https://x.test/api/items", class: "tracker" }), "tracker");
  assert.equal(causeClass({ url: "https://x.test/api/items" }), "api");
});

test("store diff and frame slicing", () => {
  const stores = causeDiffStores(
    { stores: [{ kind: "redux", source: "__STORE__", data: { filter: "all", items: 3 } }] },
    {
      stores: [
        { kind: "redux", source: "__STORE__", data: { filter: "tech", items: 3, token: "x" } },
      ],
    },
  );
  assert.deepEqual(plain(stores), [
    { kind: "redux", path: "__STORE__.filter", before: "all", after: "tech" },
    { kind: "redux", path: "__STORE__.token", before: null, after: "[redacted]" },
  ]);
  const old = [{ seq: 1, url: "wss://x", data: "a" }];
  const now = old.concat([{ seq: 2, url: "wss://x", direction: "received", data: { t: 1 } }]);
  assert.deepEqual(plain(causeSliceFrames(old, now)), [
    { stream: "wss://x", direction: "received", sample: '{"t":1}' },
  ]);
  assert.deepEqual(
    plain(causeSliceFrames({ frames: old }, { frames: now })),
    plain(causeSliceFrames(old, now)),
  );
});

function sandbox() {
  const context = vm.createContext({ console, setTimeout, URL, __helpTopics: {} });
  vm.runInContext(browserPosthocNetApi, context);
  vm.runInContext(browserCauseApi, context);
  return context;
}

// A fake page whose inspect() runs page code against a tiny fake document and MutationObserver.
function fakePage(context) {
  const entries = [{ id: "1", method: "GET", url: "https://x.test/api/items?cat=all" }];
  let observers = 0;
  let storeFilter = "all";
  let href = "https://x.test/";
  const pageGlobal = {
    location: {
      get href() {
        return href;
      },
    },
    document: { documentElement: {} },
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        observers += 1;
        pageGlobal.__fire = fn;
      }
      observe() {}
      disconnect() {
        observers -= 1;
      }
    },
  };
  pageGlobal.globalThis = pageGlobal;
  const pageRealm = vm.createContext(pageGlobal);
  const base = {
    network: { list: async () => entries.slice() },
    inspect: async (fn) =>
      typeof fn === "function"
        ? vm.runInContext("(" + String(fn) + ")()", pageRealm)
        : vm.runInContext(fn, pageRealm),
    state: Object.assign(() => ({}), {
      stores: async () => ({
        stores: [{ kind: "redux", source: "__STORE__", data: { filter: storeFilter } }],
      }),
    }),
  };
  const click = () => {
    entries.push({ id: "2", method: "GET", url: "https://x.test/api/items?cat=tech", status: 200 });
    entries.push({ id: "3", method: "POST", url: "https://x.test/collect" });
    storeFilter = "tech";
    href = "https://x.test/?cat=tech";
    pageGlobal.__fire([
      { type: "childList", addedNodes: [{ textContent: "Tech items" }], removedNodes: [] },
    ]);
    return "clicked";
  };
  return { page: context.__extendPageCause(undefined, base), click, open: () => observers };
}

test("page.cause end to end against a fake page", async () => {
  const context = sandbox();
  const { page, click, open } = fakePage(context);
  const fx = plain(await page.cause(click, { settleMs: 0 }));
  assert.equal(fx.requests.length, 1);
  assert.deepEqual(fx.requests[0].diff, { query: { cat: ["all", "tech"] } });
  assert.equal(fx.noise.tracker, 1);
  assert.deepEqual(fx.url, { before: "https://x.test/", after: "https://x.test/?cat=tech" });
  assert.deepEqual(fx.stores, [
    { kind: "redux", path: "__STORE__.filter", before: "all", after: "tech" },
  ]);
  assert.equal(fx.dom.added, 1);
  assert.deepEqual(fx.dom.samples, ["Tech items"]);
  assert.equal(fx.result, "clicked");
  assert.equal(open(), 0);
});

test("page.cause disconnects its observer when the action throws", async () => {
  const context = sandbox();
  const { page, open } = fakePage(context);
  await assert.rejects(
    page.cause(
      () => {
        throw new Error("boom");
      },
      { settleMs: 0 },
    ),
    /boom/,
  );
  assert.equal(open(), 0);
});
