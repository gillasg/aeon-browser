import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteModel, templatePaths } from "../dist/index.js";
import { exchange } from "./shape-exchanges.mjs";

const O = "https://shop.example";

test("sibling endpoints under /api stay separate operations", async () => {
  const exchanges = [
    exchange(`${O}/api/products?q=lamp`, { json: { query: "lamp", results: [{ id: 1 }] } }),
    exchange(`${O}/api/feed`, { json: { items: [{ id: 1 }], nextCursor: "NQ==" } }),
    exchange(`${O}/api/list?offset=0&limit=20`, { json: { total: 70, items: [{ id: 1 }] } }),
    exchange(`${O}/api/stream?q=a`, { body: '{"i":0}\n{"i":1}\n', mime: "application/x-ndjson" }),
    exchange(`${O}/api/token`, { json: { token: "t1" } }),
  ];
  const { model } = await buildSiteModel(exchanges, { site: "shop.example" });
  const paths = model.operations.map((o) => o.path).sort();
  assert.deepEqual(paths, ["/api/feed", "/api/list", "/api/products", "/api/stream", "/api/token"]);
});

test("responses without a known shape never count as the same shape", async () => {
  // Passive captures without bodies: five words under /data are five endpoints.
  const exchanges = ["alpha", "beta", "gamma", "delta", "omega"].map((word) =>
    exchange(`${O}/data/${word}`, { body: "", mime: "application/json" }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "shop.example" });
  assert.equal(model.operations.length, 5);
});

test("three siblings with alike JSON shapes are one template", () => {
  const shape = "bio,id,name";
  const paths = templatePaths(
    ["alice", "bob", "carol"].map((user) => ({ url: `${O}/users/${user}`, shape })),
  );
  assert.ok(paths.every((p) => p.template === "/users/{user}"));
});

test("a single word under an API root is never templated from samples", () => {
  const shape = "id,items";
  const paths = templatePaths(
    ["orders", "carts", "lists", "users"].map((word) => ({ url: `${O}/api/${word}`, shape })),
  );
  assert.deepEqual(
    paths.map((p) => p.template),
    ["/api/orders", "/api/carts", "/api/lists", "/api/users"],
  );
  // A bundle route template still may.
  const routed = templatePaths([{ url: `${O}/api/orders`, shape }], ["/api/{resource}"]);
  assert.equal(routed[0].template, "/api/{resource}");
});

test("telemetry hosts are dropped; the site's own cross-host search is kept", async () => {
  const page = `${O}/search?q=rust`;
  const exchanges = [
    exchange("https://abc-dsn.search.example/1/indexes/items/query", {
      method: "POST",
      requestBody: '{"query":"rust"}',
      headers: { "content-type": "application/json" },
      json: { hits: [{ title: "Rust in action" }], nbHits: 1 },
      pageUrl: page,
    }),
    exchange("https://telemetry.search.example/1/usage", {
      method: "POST",
      requestBody: '{"a":1}',
      json: { hits: [{ title: "x" }], nbHits: 1 },
      pageUrl: page,
    }),
  ];
  const { model } = await buildSiteModel(exchanges, {
    site: "shop.example",
    overrides: { origins: ["shop.example"] },
  });
  assert.deepEqual(
    model.operations.map((o) => o.origin),
    ["https://abc-dsn.search.example"],
  );
  assert.ok(model.origins.includes("https://abc-dsn.search.example"));
});
