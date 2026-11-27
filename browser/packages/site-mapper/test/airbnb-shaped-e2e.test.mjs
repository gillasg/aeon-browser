import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBundle } from "../dist/bundle-graph.js";
import { callWithBundleHeal, resetBundleHealCache } from "../dist/bundle-heal-run.js";
import {
  buildRequest,
  INFERENCE_VERSION,
  loadModel,
  readOverrides,
  readTransportPreferences,
  rebuild,
  saveFlow,
  saveModel,
  siteMapper,
} from "../dist/index.js";
import { har, harEntry } from "./har-entries.mjs";
import { tempHome } from "./helpers.mjs";

// A strict, Airbnb-shaped site end to end: the stored capture has a persisted GraphQL hash in the
// path, a sealed API key and a header recorded twice. The model needs no inputs, the call goes
// through the live page (the sealed handle is never sent), and when the site rotates its hash,
// the bundle heal finds the new one in the page's code and the retry answers.

const SITE = "stays.example";
const ORIGIN = `https://www.${SITE}`;
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const SEALED = "graft-sealed:abc123def456";
const MISS = { errors: [{ message: "PersistedQueryNotFound" }] };

function suggestUrl(hash) {
  const variables = encodeURIComponent(JSON.stringify({ query: "paris" }));
  const extensions = encodeURIComponent(
    JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  );
  return `${ORIGIN}/api/v3/AutoSuggestionsQuery/${hash}?operationName=AutoSuggestionsQuery&locale=en&variables=${variables}&extensions=${extensions}`;
}

async function storeCapture() {
  const headers = {
    "x-airbnb-api-key": SEALED,
    "x-airbnb-graphql-platform": "web, web",
    "content-type": "application/json",
  };
  const json = { data: { autoSuggestions: [{ name: "Paris" }] } };
  const entries = [1, 2, 3].map(() => harEntry(suggestUrl(OLD), { headers, json }));
  await saveFlow(SITE, { name: "browse", recordedAt: new Date().toISOString() }, har(entries));
  return (await rebuild(SITE)).model;
}

// The live page: it answers for the current hash and misses the rotated one.
function livePage() {
  return {
    name: "page",
    sent: [],
    async send(request) {
      this.sent.push(request);
      const ok = request.url.includes(`/AutoSuggestionsQuery/${NEW}`) && request.url.includes(NEW);
      const json = ok ? { data: { autoSuggestions: [{ name: "Paris, France" }] } } : MISS;
      return { status: 200, headers: { "content-type": "application/json" }, json };
    },
  };
}

const direct = {
  name: "direct",
  async send() {
    throw new Error("a sealed operation must never go out over plain HTTP");
  },
};

test("Airbnb-shaped site: clean model, page routing, and persisted-hash self-repair", async (t) => {
  await tempHome(t);
  resetBundleHealCache();
  const model = await storeCapture();
  assert.equal(model.inferenceVersion, INFERENCE_VERSION);
  const [op] = model.operations;
  assert.equal(op.kind, "graphql");
  const hashParam = op.params.find((param) => param.persistedHash);
  assert.ok(hashParam ? hashParam.constant === OLD : op.path.includes(OLD), "hash is fixed");
  const platform = op.params.find((param) => param.name === "x-airbnb-graphql-platform");
  assert.equal(platform.constant, "web");
  const built = buildRequest(op, {});
  assert.deepEqual(built.missing, [], "no required inputs");
  assert.deepEqual(built.request.pageHeaders, ["x-airbnb-api-key"]);
  assert.ok(!JSON.stringify(built.request).includes("graft-sealed:"));

  const page = livePage();
  let scans = 0;
  const deps = {
    loadModel,
    saveModel: async (next) => saveModel(next, await readOverrides(SITE)),
    bundle: async () => {
      scans++;
      return analyzeBundle(
        `${ORIGIN}/app.js`,
        `fetch("/api/v3/AutoSuggestionsQuery/${NEW}", {operationName: "AutoSuggestionsQuery", extensions: {persistedQuery: {sha256Hash: "${NEW}"}}})`,
      );
    },
    call: async (site, id, params, using) =>
      (
        await siteMapper(site, { ...(using ? { model: using } : {}), transports: { direct, page } })
      ).call(id, params),
  };
  const result = await callWithBundleHeal(SITE, op.id, {}, deps);
  assert.deepEqual(result.data.autoSuggestions, [{ name: "Paris, France" }]);
  assert.equal(result.bundleHeal.kind, "graphql_hash");
  assert.ok(page.sent.length >= 2, "the old hash missed, the new one answered");
  assert.ok(page.sent[0].url.includes(OLD));
  assert.ok(!JSON.stringify(page.sent).includes("graft-sealed:"));

  const saved = (await loadModel(SITE)).operations.find((item) => item.id === op.id);
  assert.ok(JSON.stringify(saved).includes(NEW) && !saved.path.includes(OLD));
  assert.equal((await readTransportPreferences(SITE))[op.id]?.transport, "page");

  // The repaired operation answers at once next time: no second bundle scan.
  const again = await callWithBundleHeal(SITE, op.id, {}, deps);
  assert.deepEqual(again.data.autoSuggestions, [{ name: "Paris, France" }]);
  assert.equal(scans, 1);
});
