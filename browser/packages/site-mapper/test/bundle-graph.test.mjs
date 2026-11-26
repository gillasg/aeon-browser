import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBundle,
  analyzeBundles,
  confirmCandidates,
  worthParsing,
} from "../dist/bundle-graph.js";
import { collapse, maybeUrl, toTemplate } from "../dist/bundle-strings.js";
import { parseBundle } from "../dist/bundle-graph.js";

const FILE = "https://shop.test/static/app.js";

function find(graph, predicate) {
  return graph.candidates.find(predicate);
}

test("string concatenation and template literals fold into route templates", () => {
  const graph = analyzeBundle(
    FILE,
    `const id = user.id;
     fetch("/u/" + id);
     fetch(\`/api/posts/\${post}/comments?page=\${n}&sort=new\`);`,
  );
  const concat = find(graph, (c) => c.url === "/u/EXPR");
  assert.equal(concat.template, "/u/{param}");
  const literal = find(graph, (c) => c.template === "/api/posts/{param}/comments");
  assert.deepEqual(literal.query, ["page", "sort"]);
});

test("named string constants resolve inside concatenations", () => {
  const graph = analyzeBundle(FILE, `const API = "/api/v2"; fetch(API + "/orders/" + id);`);
  assert.ok(find(graph, (c) => c.template === "/api/v2/orders/{param}"));
});

test("fetch reads method, header names and JSON body keys from its init", () => {
  const graph = analyzeBundle(
    FILE,
    `fetch("/api/cart", {method: "post", headers: {"x-csrf-token": t, accept: "json"},
       body: JSON.stringify({sku: s, qty: 1})});`,
  );
  const call = find(graph, (c) => c.template === "/api/cart");
  assert.equal(call.method, "POST");
  assert.equal(call.sink, "fetch");
  assert.deepEqual(call.headers, ["x-csrf-token", "accept"]);
  assert.deepEqual(call.bodyKeys, ["sku", "qty"]);
});

test("XHR open collects the setRequestHeader calls that follow it", () => {
  const graph = analyzeBundle(
    FILE,
    `var x = new XMLHttpRequest(); x.open("PUT", "/api/profile/" + uid);
     x.setRequestHeader("X-Signature", sig); x.setRequestHeader("Content-Type", "json"); x.send(b);`,
  );
  const call = find(graph, (c) => c.sink === "xhr");
  assert.equal(call.method, "PUT");
  assert.equal(call.template, "/api/profile/{param}");
  assert.deepEqual(call.headers, ["X-Signature", "Content-Type"]);
});

test("axios and jQuery call shapes are all recognised", () => {
  const graph = analyzeBundle(
    FILE,
    `axios.get("/api/items"); axios.post("/api/items", data, {headers: {"x-k": 1}});
     axios({url: "/api/search", method: "patch"});
     $.get("/legacy/list"); $.post("/legacy/save"); $.ajax({url: "/legacy/ajax", type: "DELETE"});
     jQuery.ajax("/legacy/two", {method: "PUT"});`,
  );
  const by = (template) => find(graph, (c) => c.template === template);
  assert.equal(by("/api/items").method, "GET");
  assert.equal(by("/api/search").method, "PATCH");
  assert.equal(by("/legacy/save").method, "POST");
  assert.equal(by("/legacy/ajax").method, "DELETE");
  assert.equal(by("/legacy/two").method, "PUT");
  assert.ok(graph.candidates.some((c) => c.sink === "axios" && c.method === "POST"));
});

test("navigations are tagged apart from API calls", () => {
  const graph = analyzeBundle(
    FILE,
    `location.href = "/checkout/" + id; window.location.assign("/login?next=" + p);
     window.open("https://help.shop.test/faq"); router.push("/orders/" + o);
     history.pushState({}, "", "/feed"); fetch("/api/feed");`,
  );
  const nav = graph.candidates.filter((c) => c.kind === "navigation").map((c) => c.template);
  assert.deepEqual(
    nav.sort(),
    [
      "/checkout/{param}",
      "/feed",
      "/login",
      "/orders/{param}",
      "https://help.shop.test/faq",
    ].sort(),
  );
  assert.equal(find(graph, (c) => c.template === "/api/feed").kind, "api");
});

test("new URL and URLSearchParams give endpoints and query keys", () => {
  const graph = analyzeBundle(
    FILE,
    `const u = new URL("/api/geo", location.origin); const q = new URLSearchParams({lat: a, lng: b});`,
  );
  assert.ok(find(graph, (c) => c.sink === "new URL" && c.template === "/api/geo"));
  assert.deepEqual(graph.queryParams, ["lat", "lng"]);
});

test("GraphQL gql templates, query bodies and persisted-query hashes", () => {
  const hash = "a".repeat(64);
  const graph = analyzeBundle(
    FILE,
    `const Q = gql\`query ProductPage($id: ID!) { product(id: $id) { name } }\`;
     const F = gql\`fragment Bits on Product { id }\`;
     client.post("/graphql", {operationName: "AddToCart", query: "mutation AddToCart { add { ok } }"});
     const p = {operationName: "Feed", extensions: {persistedQuery: {version: 1, sha256Hash: "${hash}"}}};
     const e = {persistedQuery: {sha256Hash: "${hash.replace(/a/g, "b")}"}};`,
  );
  const ops = graph.candidates.filter((c) => c.kind === "graphql");
  assert.ok(ops.some((c) => c.operationName === "ProductPage" && c.operationType === "query"));
  assert.ok(ops.some((c) => c.operationName === "AddToCart" && c.operationType === "mutation"));
  assert.ok(ops.some((c) => c.sha256 === "b".repeat(64)));
  assert.equal(ops.filter((c) => c.sink === "gql").length, 1, "fragments are not operations");
});

test("route tables, build manifests, chunk edges, flags and config blobs", () => {
  const graph = analyzeBundle(
    FILE,
    `const routes = [{path: "/users/:userId", component: User}, {path: "/p/[slug]", element: P}];
     self.__BUILD_MANIFEST = {"/cart": ["static/chunks/pages/cart-1a.js"], __rewrites: {}};
     import("./chunks/lazy-9f.js");
     const f = useFlag("new_checkout"); if (isFeatureEnabled("dark-mode")) {}
     window.__APP_CONFIG__ = {apiBase: "https://api.shop.test", sentryDsn: "x"};
     const s = {featureFlags: {beta: true, promo: false}};`,
  );
  const routes = graph.candidates.filter((c) => c.kind === "route").map((c) => c.template);
  assert.ok(routes.includes("/users/{userId}"));
  assert.ok(routes.includes("/p/{slug}"));
  assert.ok(routes.includes("/cart"));
  assert.ok(graph.chunks.some((e) => e.to === "https://shop.test/static/chunks/pages/cart-1a.js"));
  assert.ok(graph.chunks.some((e) => e.to === "https://shop.test/static/chunks/lazy-9f.js"));
  assert.deepEqual(graph.flags.sort(), ["beta", "dark-mode", "new_checkout", "promo"]);
  assert.deepEqual(graph.configs[0], {
    name: "window.__APP_CONFIG__",
    keys: ["apiBase", "sentryDsn"],
    file: FILE,
  });
});

test("every candidate is static and unconfirmed until traffic confirms it", () => {
  const graph = analyzeBundles([
    [FILE, `fetch("/api/u/" + id); fetch("/api/never", {method: "DELETE"});`],
  ]);
  assert.ok(graph.candidates.every((c) => c.provenance === "static" && c.confirmed === false));
  assert.match(graph.summary, /unconfirmed/);
  confirmCandidates(graph, [
    { method: "GET", url: "https://shop.test/api/u/42?x=1" },
    { method: "GET", url: "https://shop.test/api/never" },
  ]);
  const hit = find(graph, (c) => c.template === "/api/u/{param}");
  assert.equal(hit.confirmed, true);
  assert.equal(hit.provenance, "observed");
  assert.equal(
    find(graph, (c) => c.template === "/api/never").confirmed,
    false,
    "method must match",
  );
});

test("the pre-filter, URL gate and parse fallbacks keep noise out", () => {
  assert.equal(worthParsing("var a = 1 + 2;"), false);
  assert.equal(worthParsing('fetch("/x")'), true);
  assert.equal(maybeUrl("/api/x"), true);
  assert.equal(maybeUrl("hello world"), false);
  assert.equal(maybeUrl("a/b c"), false);
  assert.equal(maybeUrl("./local.js"), false);
  assert.equal(maybeUrl("https://cdn.test/x"), true);
  assert.equal(maybeUrl("https://localhost/x"), false);
  assert.deepEqual(toTemplate("/a/EXPR/b/EXPR"), { template: "/a/{param}/b/{param2}", query: [] });
  assert.equal(collapse(parseBundle("x").body[0].expression), undefined);
  assert.ok(parseBundle("return fetch('/api/a')"), "script fallback allows top-level return");
  const broken = analyzeBundle(FILE, 'fetch("/api/a" +');
  assert.equal(broken.candidates.length, 0);
  assert.match(broken.notes[0], /could not parse/);
});
