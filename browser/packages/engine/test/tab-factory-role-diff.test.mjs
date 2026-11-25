import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserProfilesApi } from "../dist/code-api-profiles.js";

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (values) => Object.assign(store, values),
    },
  },
};
const { placementSpace, tabPlacement, TAB_PLACEMENT_KEY } =
  await import("../dist/native-browser-placement.js");

const ADMIN = "aaaaaaaa-1111-4111-8111-111111111111";
const VIEWER = "bbbbbbbb-2222-4222-8222-222222222222";

function realm(browsers, extra = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    __call: async (value) => (value.browserInfo ? { browsers } : {}),
    browser: {},
    ...extra,
  });
  vm.runInContext(browserProfilesApi, context);
  return context;
}

test("placement: background tabs default to the unfocused agent window", async () => {
  delete store[TAB_PLACEMENT_KEY];
  assert.equal(await tabPlacement(), "background-window");
  assert.equal(await placementSpace({ background: true }, () => "tabs"), "window");
});

test("placement: current-window-group keeps background tabs in this window", async () => {
  store[TAB_PLACEMENT_KEY] = "current-window-group";
  assert.equal(await placementSpace({ background: true }, () => "window"), "tabs");
  delete store[TAB_PLACEMENT_KEY];
});

test("placement: a normal openTab and an explicit space are untouched", async () => {
  assert.equal(await placementSpace({}, () => "tabs"), "tabs");
  assert.equal(await placementSpace({ background: true, space: "tabs" }, () => "window"), "tabs");
});

test("placement options map onto the step", () => {
  const r = realm([]);
  assert.deepEqual({ ...r.__placementStep({}) }, {});
  assert.deepEqual({ ...r.__placementStep({ background: true }) }, { background: true });
  assert.deepEqual(
    { ...r.__placementStep({ placement: "background-window" }) },
    {
      background: true,
      space: "window",
    },
  );
  assert.deepEqual(
    { ...r.__placementStep({ placement: "current-window-group" }) },
    {
      background: true,
      space: "tabs",
    },
  );
});

const two = [
  { clientInstanceId: ADMIN, name: "Admin", tabs: 3 },
  { clientInstanceId: VIEWER, name: "viewer", label: "Read only", focused: true },
];

test("profiles lists connected profiles and resolves aliases", async () => {
  const r = realm(two);
  const list = await r.__profiles();
  assert.deepEqual([...list.map((p) => p.name)], ["Admin", "viewer"]);
  assert.equal(await r.__pickClient({ browser: "admin" }), ADMIN);
  assert.equal(await r.__pickClient({ browser: "READ ONLY" }), VIEWER);
  assert.equal(await r.__pickClient({ browser: "bbbb" }), VIEWER);
  await assert.rejects(r.__pickClient({ browser: "guest" }), /UNKNOWN_BROWSER.*Admin, viewer/);
  assert.equal(await r.__pickClient({}), VIEWER, "focused profile by default");
  assert.equal(await r.__pickClient({ clientInstanceId: ADMIN }), ADMIN);
});

test("an ambiguous alias and no focused profile are clear errors", async () => {
  const r = realm([
    { clientInstanceId: ADMIN, name: "work" },
    { clientInstanceId: VIEWER, name: "work" },
  ]);
  await assert.rejects(r.__pickClient({ browser: "work" }), /AMBIGUOUS_BROWSER/);
  await assert.rejects(r.__pickClient({}), /pass \{browser: name\}/);
});

test("pool across runs one lane per profile and closes tabs on error", async () => {
  const opened = [];
  const closed = [];
  const r = realm(two);
  r.browser.openTab = async (url, options) => {
    opened.push(options);
    const page = {
      who: options.clientInstanceId,
      goto: async () => {},
      close: async () => closed.push(options.clientInstanceId),
    };
    return page;
  };
  const out = await r.__poolAcross(
    ["https://a.test/1", "https://a.test/2"],
    async (page, url, profile) => {
      if (profile === "viewer" && url.endsWith("2")) throw new Error("FORBIDDEN");
      return { url, role: page.who === ADMIN ? "admin" : "viewer", rows: 2 };
    },
    { across: ["admin", "viewer"] },
  );
  assert.equal(opened.length, 2);
  assert.ok(opened.every((o) => o.background === true && o.new === true));
  assert.deepEqual(closed.sort(), [ADMIN, VIEWER].sort());
  assert.equal(out.admin.length, 2);
  assert.equal(out.viewer[1].ok, false);
  const diff = r.__diff(out.admin, out.viewer);
  assert.equal(diff.same, false);
  assert.ok(diff.changed.some((c) => c.path === "[0].role"));
});

test("diff: identical, nested objects, keyed arrays, indexed arrays, text lines", () => {
  const r = realm([]);
  assert.equal(r.__diff({ a: [1, 2] }, { a: [1, 2] }).same, true);
  const nested = r.__diff(
    { user: { role: "admin", n: 1 }, x: 1 },
    { user: { role: "viewer", n: 1 }, y: 2 },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(nested.changed)), [
    { path: "user.role", a: "admin", b: "viewer" },
  ]);
  assert.equal(nested.added[0].path, "y");
  assert.equal(nested.removed[0].path, "x");
  const keyed = r.__diff(
    [
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ],
    [
      { id: 2, v: "c" },
      { id: 3, v: "d" },
    ],
  );
  assert.equal(keyed.changed[0].path, "[2].v");
  assert.equal(keyed.added[0].path, "[3]");
  assert.equal(keyed.removed[0].path, "[1]");
  const indexed = r.__diff([1, 2], [1, 3, 4]);
  assert.equal(indexed.changed[0].path, "[1]");
  assert.equal(indexed.added[0].path, "[2]");
  const text = r.__diff("Home\nBilling\nUsers", "Home\nUsers\nHelp");
  assert.deepEqual([...text.added.map((d) => d.value)], ["Help"]);
  assert.deepEqual([...text.removed.map((d) => d.value)], ["Billing"]);
  assert.match(text.summary, /1 added, 1 removed/);
});
