// Gauntlet #2 regressions: callable reads need no config. Persisted-hash path constants, one
// read-segment rule, seal-aware signing and CSRF, sealed header replay, an honest direct user
// agent with a page retry on a wall, and a bounded heal.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSiteModel, filterExchanges, fromHar, siteMapper } from "../dist/index.js";
import { buildOperation, finalizeNames, groupExchanges } from "../dist/infer/operations.js";
import { buildRequest } from "../dist/runtime/request.js";
import { operationEffect } from "../dist/effect.js";
import { withDeadline } from "../dist/deadline.js";

const SHA = "3f6c1d0b8a9e4f27c5d6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8";
const SEALED = "aeon-sealed:abc123def456";

function entry(method, url, { headers = {}, post, body = '{"items":[{"id":1}]}' } = {}) {
  return {
    _resourceType: "Fetch",
    request: {
      method,
      url,
      headers: Object.entries({ referer: "https://www.example.org/", ...headers }).map(
        ([name, value]) => ({ name, value }),
      ),
      ...(post ? { postData: { mimeType: "application/json", text: post } } : {}),
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { mimeType: "application/json", text: body },
    },
  };
}

const har = (...entries) => ({ log: { entries } });

function learn(capture) {
  const { kept } = filterExchanges(fromHar(capture, "test"));
  const operations = groupExchanges(kept).groups.map(buildOperation);
  finalizeNames(operations);
  return operations;
}

async function model(capture) {
  const built = await buildSiteModel(fromHar(capture, "test"), { site: "www.example.org" });
  return built.model;
}

test("a persisted hash after the GraphQL operation name is a constant, not an input", () => {
  const vars = encodeURIComponent('{"query":"par"}');
  const ext = encodeURIComponent(`{"persistedQuery":{"version":1,"sha256Hash":"${SHA}"}}`);
  const [op] = learn(
    har(
      entry(
        "GET",
        `https://www.example.org/api/v3/AutoSuggestionsQuery/${SHA}?operationName=AutoSuggestionsQuery&variables=${vars}&extensions=${ext}`,
        { body: '{"data":{"suggestions":[{"id":1}]}}' },
      ),
    ),
  );
  const hash = op.params.find((p) => p.in === "path");
  assert.ok(hash, JSON.stringify(op.params));
  assert.equal(hash.constant, SHA);
  assert.equal(hash.persistedHash, true);
  assert.equal(hash.required, false);
  const { request, missing } = buildRequest(op, {});
  assert.ok(!missing.some((m) => m.startsWith("path:")), JSON.stringify(missing));
  assert.ok(request.url.includes(`/AutoSuggestionsQuery/${SHA}`), request.url);
});

test("Bandcamp discover_web is a read, collection_add stays an action", () => {
  const filter = JSON.stringify({ tag_norm_names: ["ambient"], slice: "best", size: 24 });
  const ops = learn(
    har(
      entry("POST", "https://www.example.org/api/discover/1/discover_web", {
        post: filter,
        body: '{"results":[]}',
      }),
      entry("POST", "https://www.example.org/api/fan/2/collection_add", {
        post: '{"item_id":1}',
        body: '{"ok":true}',
      }),
    ),
  );
  const discover = ops.find((o) => o.path.endsWith("discover_web"));
  const add = ops.find((o) => o.path.endsWith("collection_add"));
  assert.equal(discover.role, "read");
  assert.equal(operationEffect(discover), "read");
  assert.equal(add.role, "action");
});

test("a redacted per-call challenge token (Booking chal_t) is signed, not an input", async () => {
  const m = await model(
    har(
      entry("GET", "https://www.example.org/api/search?q=a&chal_t=%3Credacted%3E"),
      entry("GET", "https://www.example.org/api/search?q=b&chal_t=%3Credacted%3E"),
    ),
  );
  const op = m.operations.find((o) => o.path === "/api/search");
  assert.ok(op.signing?.query.includes("chal_t"), JSON.stringify(op.signing));
  assert.equal(op.params.find((p) => p.name === "chal_t").derived, "signer");
});

test("a sealed x-csrf-token (AniList) is session-derived and sent through the page", async () => {
  const headers = { "x-csrf-token": SEALED };
  const m = await model(
    har(
      entry("GET", "https://www.example.org/api/media?id=1", { headers }),
      entry("GET", "https://www.example.org/api/media?id=2", { headers }),
    ),
  );
  const op = m.operations.find((o) => o.path === "/api/media");
  const csrf = op.params.find((p) => p.name === "x-csrf-token");
  assert.equal(csrf.derived, "session");
  assert.ok(buildRequest(op, { id: 3 }).request.pageHeaders?.includes("x-csrf-token"));
  assert.ok(!JSON.stringify(buildRequest(op, { id: 3 }).request.headers).includes(SEALED));
});

function headerOp(param) {
  return {
    id: "op",
    method: "GET",
    origin: "https://www.example.org",
    path: "/api/x",
    kind: "rest",
    params: [{ in: "header", required: false, schema: { type: "string" }, ...param }],
    dependencies: [],
    samples: [],
  };
}

test("a sealed or redacted header is never replayed; the request needs the page", () => {
  for (const value of [SEALED, "<redacted>", `Bearer ${SEALED}`]) {
    const { request } = buildRequest(headerOp({ name: "x-app-key", constant: value }));
    assert.equal(request.headers["x-app-key"], undefined, value);
    assert.deepEqual(request.pageHeaders, ["x-app-key"]);
  }
});

test("doubled recorded header values heal on read", () => {
  const { request } = buildRequest(headerOp({ name: "x-platform", examples: ["web, web"] }));
  assert.equal(request.headers["x-platform"], "web");
  const two = buildRequest(headerOp({ name: "x-mode", constant: "a, a" })).request;
  assert.equal(two.headers["x-mode"], "a");
});

function listModel(origin) {
  const site = new URL(origin).host;
  return {
    version: 1,
    site,
    title: "T",
    generatedAt: new Date().toISOString(),
    origins: [origin],
    security: [],
    operations: [
      {
        id: "list",
        method: "GET",
        origin,
        path: "/api/list",
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
        pageUrls: [`${origin}/`],
        samples: [],
      },
    ],
    pages: [],
    channels: [],
    components: {},
    noise: [],
    stats: { exchanges: 1, kept: 1, captures: [] },
  };
}

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), "flywheel-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("direct HTTP sends an honest UA: a server that 429s Chrome UAs over Node answers", async (t) => {
  await home(t);
  const server = createServer((req, res) => {
    const chrome = /Chrome\//.test(req.headers["user-agent"] ?? "");
    res.writeHead(chrome ? 429 : 200, { "content-type": "application/json" });
    res.end(chrome ? '{"error":"slow down"}' : '{"items":[1]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const m = listModel(origin);
  const dir = join(process.env.SITE_TO_API_HOME, "sites", m.site);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "model.json"), JSON.stringify(m));
  const api = await siteMapper(m.site, { model: m, session: false, transport: "direct" });
  const started = Date.now();
  const answer = await api.list();
  assert.deepEqual(answer.items, [1]);
  assert.ok(Date.now() - started < 2000);
});

test("a direct 429 in auto mode goes to the page once, at once, with no backoff", async (t) => {
  await home(t);
  const m = listModel("https://shop.example");
  let directCalls = 0;
  let pageCalls = 0;
  const direct = {
    name: "direct",
    async send() {
      directCalls++;
      return { status: 429, headers: { "retry-after": "30" }, text: "" };
    },
  };
  const page = {
    name: "page",
    async send() {
      pageCalls++;
      return { status: 200, headers: {}, json: { items: [2] } };
    },
  };
  const api = await siteMapper(m.site, { model: m, transports: { direct, page }, session: false });
  const started = Date.now();
  const answer = await api.list();
  assert.deepEqual(answer.items, [2]);
  assert.equal(directCalls, 1);
  assert.equal(pageCalls, 1);
  assert.ok(Date.now() - started < 2000, "no 30 s backoff");
});

test("a deadline answers late work with the decline", async () => {
  const never = new Promise(() => {});
  const out = await withDeadline(never, 20, { healed: false, declined: "timeout" });
  assert.deepEqual(out, { healed: false, declined: "timeout" });
  assert.equal(await withDeadline(Promise.resolve(1), 1000, "late"), 1);
});

test("leaked noise hosts never become operations", () => {
  const ops = learn(
    har(
      entry("POST", "https://id5-sync.com/api/v1/sync", { post: "{}" }),
      entry("GET", "https://pixel-config.reddit.com/api/pixels/x"),
      entry("GET", "https://r.stripe.com/api/b"),
      entry("GET", "https://otel.example.org/api/v1/traces"),
      entry("GET", "https://fundingchoicesmessages.google.com/api/el/x"),
      entry("GET", "https://www.example.org/api/items"),
    ),
  );
  assert.deepEqual(
    ops.map((o) => new URL(o.origin).host),
    ["www.example.org"],
  );
});
