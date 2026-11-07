import assert from "node:assert/strict";
import test from "node:test";

const store = {};
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (items) => Object.assign(store, items),
    },
  },
};
const { SessionMap } = await import("../dist/native-session-map.js");

const asSet = [(values) => [...values], (values) => new Set(values)];

test("a SessionMap comes back after the service worker restarts", async () => {
  const first = new SessionMap("typed", ...asSet);
  await first.ready;
  first.set(7, new Set(["secret-the-agent-typed"]));
  first.set(8, new Set(["other"]));
  first.delete(8);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // A new worker: a fresh map with the same key.
  const second = new SessionMap("typed", ...asSet);
  await second.ready;
  assert.deepEqual([...second.keys()], [7]);
  assert.ok(second.get(7).has("secret-the-agent-typed"));
});

test("without session storage it is a plain map", async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = undefined;
  const map = new SessionMap("none");
  await map.ready;
  map.set(1, "a");
  assert.equal(map.get(1), "a");
  globalThis.chrome = saved;
});
