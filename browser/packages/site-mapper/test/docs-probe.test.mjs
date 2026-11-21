// The docs probe looks for OpenAPI documents at ten usual paths. A host that hangs instead of
// refusing used to stall mapping: the paths were tried one after another with no timeout.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { docsExpression, docsTargets } from "../dist/runtime/docs.js";

function run(targets, fetchImpl, limits) {
  const context = vm.createContext({
    fetch: fetchImpl,
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    Array,
    Map,
  });
  return vm.runInContext(docsExpression(targets, limits), context);
}

const doc = { openapi: "3.0.0", info: { title: "Shop" }, paths: { "/items": { get: {} } } };

/** A fetch that never answers on its own, and rejects when its signal aborts, as a real one does. */
function hanging(signal) {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

test("hung doc endpoints are cut off by the per-fetch timeout", async () => {
  const targets = {
    docs: ["https://a.test/openapi.json", "https://a.test/swagger.json"],
    graphql: [],
  };
  const started = Date.now();
  const found = await run(targets, (_url, init) => hanging(init.signal), {
    fetchMs: 50,
    totalMs: 2000,
  });
  assert.equal(found.openapi.length, 0);
  assert.ok(Date.now() - started < 1000, "both hung fetches ended on their own timeouts");
});

test("fetches run a few at a time, not one after another", async () => {
  const docs = Array.from({ length: 10 }, (_, i) => `https://a.test/${i}.json`);
  let live = 0;
  let peak = 0;
  const fetchImpl = async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((done) => setTimeout(done, 20));
    live -= 1;
    return { ok: false, json: async () => ({}) };
  };
  await run({ docs, graphql: [] }, fetchImpl, { concurrency: 4 });
  assert.equal(peak, 4);
});

test("a fetch that ignores its abort cannot hold the probe past the total budget", async () => {
  const docs = Array.from({ length: 6 }, (_, i) => `https://a.test/${i}.json`);
  const started = Date.now();
  const found = await run({ docs, graphql: [] }, () => new Promise(() => {}), {
    fetchMs: 5000,
    totalMs: 120,
  });
  assert.equal(found.openapi.length, 0);
  assert.ok(Date.now() - started < 1000);
});

test("documents that answer are returned in the order of the paths, with the slow ones skipped", async () => {
  const docs = ["https://a.test/one.json", "https://a.test/two.json", "https://a.test/three.json"];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("two.json")) return hanging(init.signal);
    const delay = url.endsWith("one.json") ? 30 : 0;
    await new Promise((done) => setTimeout(done, delay));
    return { ok: true, json: async () => ({ ...doc, info: { title: url } }) };
  };
  const found = await run({ docs, graphql: [] }, fetchImpl, { fetchMs: 100, totalMs: 1000 });
  assert.deepEqual(
    Array.from(found.openapi, (item) => item.title),
    ["https://a.test/one.json", "https://a.test/three.json"],
  );
});

test("graphql introspection is bounded the same way", async () => {
  const found = await run(
    { docs: [], graphql: ["https://a.test/graphql"] },
    (_url, init) => hanging(init.signal),
    { fetchMs: 40, totalMs: 1000 },
  );
  assert.equal(found.graphql.length, 0);
});

test("targets still list the usual paths on every origin", () => {
  const targets = docsTargets({ site: "a.test", origins: ["https://a.test"], operations: [] });
  assert.equal(targets.docs.length, 10);
});
