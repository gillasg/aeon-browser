import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeBundle } from "../dist/bundle-graph.js";
import { isHealableFailure, proposeRebind, safeToReplay } from "../dist/bundle-heal.js";
import {
  callWithBundleHeal,
  healOpFromBundle,
  resetBundleHealCache,
} from "../dist/bundle-heal-run.js";

process.env.SITE_TO_API_HOME = mkdtempSync(join(tmpdir(), "bundle-heal-"));

const OLD = "oldHashAAAAAAAAAAAAAAAA";
const NEW = "newHashBBBBBBBBBBBBBBBB";
const SHA_OLD = "a".repeat(64);
const SHA_NEW = "b".repeat(64);

function op(extra) {
  return {
    id: "op",
    method: "GET",
    origin: "https://x.test",
    path: "/",
    kind: "rest",
    params: [],
    responses: {},
    role: "read",
    security: [],
    dependencies: [],
    confidence: 1,
    bucket: "high",
    flags: [],
    sampleCount: 1,
    sources: [],
    pageUrls: [],
    samples: [],
    ...extra,
  };
}

const graphOf = (code) => analyzeBundle("https://x.test/app.js", code);

test("rotated GraphQL hash in the URL path rebinds by operation name", () => {
  const home = op({
    kind: "graphql",
    path: `/i/api/graphql/${OLD}/HomeTimeline`,
    graphql: { operationName: "HomeTimeline", variablesPath: "variables" },
  });
  const out = proposeRebind(home, graphOf(`fetch("/i/api/graphql/${NEW}/HomeTimeline")`));
  assert.equal(out.rebind.kind, "graphql_hash");
  assert.equal(out.rebind.path, `/i/api/graphql/${NEW}/HomeTimeline`);
  assert.ok(out.rebind.confidence >= 0.7);
});

test("rotated persistedQuery sha256Hash matches by operationName", () => {
  const feed = op({
    kind: "graphql",
    method: "POST",
    path: "/graphql",
    graphql: {
      operationName: "Feed",
      variablesPath: "variables",
      extensions: { persistedQuery: { version: 1, sha256Hash: SHA_OLD } },
    },
  });
  const graph = graphOf(
    `send({operationName: "Feed", extensions: {persistedQuery: {sha256Hash: "${SHA_NEW}"}}});
     send({operationName: "Other", extensions: {persistedQuery: {sha256Hash: "${"c".repeat(64)}"}}});`,
  );
  const out = proposeRebind(feed, graph);
  assert.equal(out.rebind.hash, SHA_NEW);
  assert.equal(out.rebind.path, "/graphql");
});

test("REST version bump keeps the parameter names", () => {
  const order = op({ path: "/api/v1/orders/{orderId}" });
  const out = proposeRebind(order, graphOf(`fetch("/api/v2/orders/" + id)`));
  assert.equal(out.rebind.kind, "rest_path");
  assert.equal(out.rebind.path, "/api/v2/orders/{orderId}");
});

test("a candidate on an unrelated host is rejected", () => {
  const order = op({ path: "/api/v1/orders/{orderId}" });
  const out = proposeRebind(order, graphOf(`fetch("https://evil.example/api/v2/orders/" + id)`));
  assert.ok("declined" in out);
});

test("ambiguous candidates decline and leave the stored op alone", async () => {
  resetBundleHealCache();
  const model = { site: "x.test", operations: [op({ path: "/api/v1/orders/{orderId}" })] };
  let saved = 0;
  const outcome = await healOpFromBundle(
    "x.test",
    "op",
    {},
    {
      loadModel: async () => model,
      saveModel: async () => saved++,
      bundle: async () => graphOf(`fetch("/api/v2/orders/" + a); fetch("/api/v3/orders/" + b);`),
      call: async () => ({ ok: true }),
    },
  );
  assert.equal(outcome.healed, false);
  assert.match(outcome.declined, /ambiguous/);
  assert.equal(saved, 0);
  assert.equal(model.operations[0].path, "/api/v1/orders/{orderId}");
});

test("non-idempotent writes are not replayed on a 404", async () => {
  resetBundleHealCache();
  const write = op({ method: "POST", role: "action", path: "/api/v1/orders" });
  assert.equal(safeToReplay(write), false);
  let calls = 0;
  const deps = {
    loadModel: async () => ({ site: "x.test", operations: [write] }),
    saveModel: async () => assert.fail("must not save"),
    bundle: async () => graphOf(`fetch("/api/v2/orders", {method: "POST"})`),
    call: async () => {
      calls++;
      throw new Error("op answered HTTP 404: gone");
    },
  };
  await assert.rejects(() => callWithBundleHeal("x.test", "op", {}, deps), /HTTP 404/);
  assert.equal(calls, 1);
  assert.equal(isHealableFailure(new Error("op answered HTTP 403: no")), false);
});

test("end to end: 404 → bundle re-scan → rebind → retry answers → next call direct", async (t) => {
  resetBundleHealCache();
  const server = createServer((req, res) => {
    if (req.url === `/i/api/graphql/${NEW}/HomeTimeline`) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: { tweets: [1, 2] } }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  let model = {
    site: "x.test",
    operations: [
      op({
        id: "home",
        kind: "graphql",
        origin,
        path: `/i/api/graphql/${OLD}/HomeTimeline`,
        graphql: { operationName: "HomeTimeline", variablesPath: "variables" },
      }),
    ],
  };
  let scans = 0;
  const deps = {
    loadModel: async () => model,
    saveModel: async (next) => (model = next),
    bundle: async () => {
      scans++;
      return graphOf(`fetch("/i/api/graphql/${NEW}/HomeTimeline")`);
    },
    call: async (_site, id, _params, using = model) => {
      const target = using.operations.find((o) => o.id === id);
      const response = await fetch(target.origin + target.path);
      if (!response.ok)
        throw new Error(`${id} answered HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    },
  };
  const first = await callWithBundleHeal("x.test", "home", {}, deps);
  assert.deepEqual(first.data.tweets, [1, 2]);
  assert.equal(first.bundleHeal.kind, "graphql_hash");
  assert.equal(first.bundleHeal.zeroModelTurns, true);
  assert.equal(model.operations[0].path, `/i/api/graphql/${NEW}/HomeTimeline`);
  const second = await callWithBundleHeal("x.test", "home", {}, deps);
  assert.deepEqual(second.data.tweets, [1, 2]);
  assert.equal(scans, 1);
});

test("a persisted hash after the operation name (/Name/<hash>) rebinds, from the param constant", () => {
  const suggest = op({
    kind: "graphql",
    path: "/api/v3/AutoSuggestionsQuery/{autoSuggestionsQueryId}",
    params: [
      {
        name: "autoSuggestionsQueryId",
        in: "path",
        required: false,
        schema: { type: "string" },
        constant: SHA_OLD,
        persistedHash: true,
      },
    ],
    graphql: { operationName: "AutoSuggestionsQuery", variablesPath: "query:variables" },
  });
  const graph = graphOf(`fetch("/api/v3/AutoSuggestionsQuery/${SHA_NEW}")`);
  const out = proposeRebind(suggest, graph);
  assert.equal(out.rebind?.kind, "graphql_hash", JSON.stringify(out));
  assert.equal(out.rebind.path, `/api/v3/AutoSuggestionsQuery/${SHA_NEW}`);
  assert.equal(out.rebind.oldTarget, `AutoSuggestionsQuery@${SHA_OLD}`);
});
