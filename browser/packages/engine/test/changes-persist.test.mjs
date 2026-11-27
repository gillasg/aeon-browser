// browser.changes() keeps its sets through the host (the daemon's SQLite store), so a watcher
// compares against its last run after a restart; a failed read or an HTTP error page is skipped
// and leaves the stored set as it was.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserChangesApi } from "../dist/code-api-changes-store.js";

/** A fresh runtime (as after a daemon restart) over the same lasting host store. */
function runtime(store, { status = null } = {}) {
  const calls = [];
  const context = vm.createContext({
    __lastTarget: status === null ? null : { tabId: 1 },
    __mainStatus: async () => status,
    __call: async (request) => {
      calls.push(request);
      if (request.changeSets === "load") {
        const entries = store.get(request.name);
        return entries ? { entries } : null;
      }
      if (request.changeSets === "save") {
        store.set(request.name, JSON.parse(JSON.stringify(request.entries)));
        return { saved: true };
      }
      throw new Error("unexpected call");
    },
  });
  vm.runInContext(browserChangesApi, context);
  return { changes: vm.runInContext("__changes", context), calls };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("the baseline survives a restart: the second runtime reports what changed", async () => {
  const store = new Map();
  const first = await runtime(store).changes("lamps", [
    { id: 1, price: 10 },
    { id: 2, price: 5 },
  ]);
  assert.equal(first.first, true);
  const after = await runtime(store).changes("lamps", [
    { id: 1, price: 12 },
    { id: 3, price: 7 },
  ]);
  assert.equal(after.first, false);
  assert.deepEqual(plain(after.new), [{ id: 3, price: 7 }]);
  assert.deepEqual(plain(after.changed), [
    { before: { id: 1, price: 10 }, after: { id: 1, price: 12 } },
  ]);
  assert.deepEqual(plain(after.gone), [{ id: 2, price: 5 }]);
});

test("{failed: true} is skipped and the baseline does not move", async () => {
  const store = new Map();
  await runtime(store).changes("feed", [{ id: "a" }]);
  const skipped = await runtime(store).changes("feed", [], { failed: true });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(store.get("feed"), [["a", { id: "a" }]]);
  const next = await runtime(store).changes("feed", [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(plain(next.new), [{ id: "b" }]);
  assert.deepEqual(plain(next.gone), []);
});

test("a page that answered HTTP 400 or more is skipped", async () => {
  const store = new Map();
  await runtime(store, { status: 200 }).changes("jobs", [{ id: 1 }]);
  const broken = await runtime(store, { status: 503 }).changes("jobs", []);
  assert.equal(broken.skipped, true);
  assert.match(broken.reason, /HTTP 503/);
  assert.deepEqual(store.get("jobs"), [["1", { id: 1 }]]);
  const explicit = await runtime(store).changes("jobs", [], { status: 404 });
  assert.equal(explicit.skipped, true);
});

test("a check written without await still gets this runtime's comparison", async () => {
  const { changes } = runtime(new Map());
  changes("sync", [{ id: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const answer = changes("sync", [{ id: 1 }, { id: 2 }]);
  assert.equal(typeof answer.then, "function");
  assert.equal(answer.first, false);
  assert.deepEqual(plain(answer.new), [{ id: 2 }]);
});
