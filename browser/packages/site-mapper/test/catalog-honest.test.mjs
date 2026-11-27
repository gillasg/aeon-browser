// The catalog tells an agent the truth: no header or plumbing inputs, defaults shown as
// optional, a description of what the tool does (never its host or method), each id input
// linked to the read that returns it, maxItems only where there are pages, and the effect of
// a delete or a display-only edit labelled right.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSiteModel,
  describeCatalogOperation,
  howToCallFor,
  inferEffect,
  mergeRotated,
  operationEffect,
  parseCapture,
  siteMapper,
  siteTools,
  writeKind,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop } from "./helpers.mjs";

const param = (name, extra = {}) => ({
  name,
  in: "query",
  required: false,
  schema: { type: "string" },
  ...extra,
});

function op(id, method, path, extra = {}) {
  return {
    id,
    method,
    path,
    origin: "http://127.0.0.1:4100",
    kind: "rest",
    role: method === "GET" ? "read" : "action",
    params: [],
    responses: {},
    dependencies: [],
    confidence: 1,
    bucket: "high",
    flags: [],
    sampleCount: 2,
    sources: [],
    pageUrls: [],
    samples: [],
    ...extra,
  };
}

const model = {
  site: "127.0.0.1:4100",
  operations: [
    op("listProducts", "GET", "/api/products", {
      params: [
        param("q", { required: true }),
        param("limit", { default: "20" }),
        param("format", { constant: "json" }),
        param("x-csrf-token", { in: "header", required: true }),
        param("x-api-key", { in: "header", required: true }),
      ],
      responses: {
        200: {
          mime: "application/json",
          schema: {
            type: "object",
            properties: { results: { type: "array" }, total: { type: "integer" } },
          },
        },
      },
    }),
    op("getProduct", "GET", "/api/products/{productId}", {
      params: [param("productId", { in: "path", required: true, examples: ["8c1d2e3f"] })],
    }),
    op("getFeed", "GET", "/api/feed", {
      pagination: { style: "cursor", param: "query:cursor", nextPointer: "/nextCursor" },
    }),
    op("deleteProduct", "DELETE", "/api/products/{productId}", {
      params: [param("productId", { in: "path", required: true })],
    }),
    op("updateProduct", "PATCH", "/api/products/{productId}", {
      params: [param("productId", { in: "path", required: true })],
      requestBody: {
        mime: "application/json",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    }),
  ],
  pages: [],
  channels: [],
};

const tools = Object.fromEntries(siteTools(model).map((tool) => [tool.name, tool]));

test("header and plumbing params are never agent inputs; PR-3 defaults are optional", () => {
  const input = tools.listProducts.inputSchema;
  assert.deepEqual(Object.keys(input.properties).sort(), ["limit", "q"]);
  assert.deepEqual(input.required, ["q"]);
  assert.match(input.properties.limit.description, /optional, defaults to 20/);
  assert.match(howToCallFor(model.operations[0]), /limit=20/);
});

test("descriptions say what a tool does, with no host and no HTTP method", () => {
  for (const tool of Object.values(tools)) {
    assert.doesNotMatch(tool.description, /127\.0\.0\.1|\bGET\b|\bPOST\b|\bDELETE\b|\bPATCH\b/);
  }
  assert.match(tools.listProducts.description, /^Search products, returns results, total/);
  assert.equal(tools.listProducts.annotations.method, "GET");
  assert.equal(tools.listProducts.annotations.host, "127.0.0.1:4100");
  assert.equal(
    describeCatalogOperation({ ...model.operations[1], summary: "GET /api/products/{productId}" }),
    "Get products",
  );
});

test("an id input names the read that returns it", () => {
  const id = tools.getProduct.inputSchema.properties.productId;
  assert.match(id.description, /get it from listProducts/);
});

test("maxItems is offered only with pages; otherwise the call answers NO_PAGINATION", async () => {
  assert.ok(tools.getFeed.inputSchema.properties.maxItems);
  assert.equal(tools.listProducts.inputSchema.properties.maxItems, undefined);
  const api = await siteMapper(model.site, { model, transport: "direct", session: false });
  await assert.rejects(
    () => api.call("listProducts", { q: "lamp", maxItems: 5 }),
    (error) => error.code === "NO_PAGINATION" && /NO_PAGINATION/.test(error.message),
  );
});

test("siteMapper.call with maxItems reads every page up to that many", async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const { model: shop } = await buildSiteModel(
    parseCapture(JSON.stringify(recorder.har()), "flow"),
    { site: new URL(site.origin).host },
  );
  const api = await siteMapper(shop.site, { model: shop, transport: "direct", session: false });
  const items = await api.call("listProducts", { limit: 5, maxItems: 12 });
  assert.equal(items.length, 12);
});

test("DELETE is irreversible with destructiveHint; so is a remove or cancel by name", () => {
  assert.equal(operationEffect(model.operations[3]), "irreversible");
  assert.equal(tools.deleteProduct.annotations.destructiveHint, true);
  assert.equal(tools.listProducts.annotations.destructiveHint, false);
  assert.equal(
    inferEffect({ method: "POST", name: "removeFromCart /cart/remove" }),
    "irreversible",
  );
  assert.equal(inferEffect({ method: "POST", name: "cancelOrder /orders/cancel" }), "irreversible");
  assert.equal(inferEffect({ method: "GET", name: "getCancelledOrders" }), "read");
  assert.equal(inferEffect({ method: "POST", name: "createProducts /api/products" }), "write");
});

test("a PATCH that changes only display fields is a routine write", () => {
  assert.equal(writeKind(model.operations[4]), "routine");
  const price = structuredClone(model.operations[4]);
  price.requestBody.schema.properties.cardNumber = { type: "string" };
  assert.equal(writeKind(price), "consequential");
  assert.equal(writeKind(model.operations[3]), "consequential");
});

test("writes not proven yet say how to unlock them", () => {
  assert.match(
    tools.updateProduct.description,
    /Do it once in the page; after that this tool repeats it/,
  );
  const proven = siteTools(model, {}, [], new Set(["updateProduct"]));
  assert.doesNotMatch(proven.find((t) => t.name === "updateProduct").description, /Do it once/);
  assert.doesNotMatch(tools.listProducts.description, /Do it once/);
});

test("a re-learned operation under a new hash replaces the old one", () => {
  const gql = (id, hash) =>
    op(id, "GET", `/gql/AutoSuggest/${hash}`, {
      kind: "graphql",
      graphql: { operationName: "AutoSuggest", hash, variablesPath: "query:variables" },
    });
  const previous = { ...model, operations: [gql("autoSuggest", "a".repeat(64))] };
  const next = {
    ...model,
    operations: [gql("autoSuggest", "a".repeat(64)), gql("autoSuggestGet", "c".repeat(64))],
  };
  const merged = mergeRotated(next, previous);
  assert.deepEqual(
    merged.operations.map((o) => o.id),
    ["autoSuggest"],
  );
  assert.match(merged.operations[0].path, /c{64}/);
});
