// Real Chrome learns a real local site: once from a tab left open (recorded passively, bodies
// handed over before they are dropped) and once from a tab the cell closed. Sibling endpoints
// stay apart, paging is found, bodies give schemas, and a stream becomes a channel.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingChrome, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const b64 = (text) => Buffer.from(text).toString("base64");

const APP = `
async function j(u){ const r = await fetch(u); return r.json(); }
(async () => {
  for (const q of ['lamp', 'chair']) await j('/api/products?q=' + q);
  let c = ''; for (let i = 0; i < 3; i++) { const r = await j('/api/feed' + (c ? '?cursor=' + c : '')); c = r.nextCursor; }
  for (const o of [0, 20, 40]) await j('/api/list?offset=' + o + '&limit=20');
  await j('/api/token');
  await new Promise((done) => { const es = new EventSource('/api/events'); let n = 0;
    es.onmessage = () => { if (++n >= 2) { es.close(); done(); } }; setTimeout(done, 3000); });
  window.__done = true;
})();`;

function site() {
  const json = (response, value) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const p = url.pathname;
    if (p === "/app") {
      response.setHeader("content-type", "text/html");
      return response.end(
        `<!doctype html><title>Shop</title><h1>Shop</h1><script src="/app.js"></script>`,
      );
    }
    if (p === "/app.js") {
      response.setHeader("content-type", "application/javascript");
      return response.end(APP);
    }
    if (p === "/api/products")
      return json(response, {
        query: url.searchParams.get("q"),
        results: [{ id: 1, name: "Lamp" }],
      });
    if (p === "/api/feed") {
      const at = Number(
        url.searchParams.has("cursor")
          ? Buffer.from(url.searchParams.get("cursor"), "base64").toString()
          : 0,
      );
      return json(response, {
        items: [{ id: at }, { id: at + 1 }],
        nextCursor: b64(String(at + 5)),
      });
    }
    if (p === "/api/list") {
      const offset = Number(url.searchParams.get("offset"));
      return json(response, {
        total: 70,
        items: Array.from({ length: 20 }, (_, i) => ({ id: offset + i })),
      });
    }
    if (p === "/api/token") return json(response, { token: "t" + Date.now() });
    if (p === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write('data: {"tick":1}\n\n');
      setTimeout(() => response.write('data: {"tick":2}\n\n'), 100);
      setTimeout(() => response.end(), 400);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      done({ base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, server });
    }),
  );
}

async function model(stack, host) {
  const path = join(stack.env.SITE_TO_API_HOME, "sites", host.replace(":", "_"), "model.json");
  return JSON.parse(await readFile(path, "utf8"));
}

function checkModel(learned) {
  const byPath = Object.fromEntries(
    learned.operations.map((op) => [`${op.method} ${op.path}`, op]),
  );
  for (const path of ["/api/products", "/api/feed", "/api/list", "/api/token"])
    assert.ok(byPath[`GET ${path}`], `missing GET ${path}: ${Object.keys(byPath).join(", ")}`);
  const feed = byPath["GET /api/feed"];
  assert.equal(feed.pagination?.style, "cursor", JSON.stringify(feed.pagination));
  assert.equal(feed.pagination.param, "query:cursor");
  const list = byPath["GET /api/list"];
  assert.equal(list.pagination?.style, "offset", JSON.stringify(list.pagination));
  // Bodies reached the learner: response schemas were inferred.
  const products = byPath["GET /api/products"];
  assert.ok(
    products.responses["200"].schema?.properties?.results,
    JSON.stringify(products.responses),
  );
  assert.equal(products.params.find((p) => p.name === "q").schema.enum, undefined);
  assert.ok(
    learned.channels.some((channel) => channel.kind === "sse"),
    JSON.stringify(learned.channels),
  );
}

test(
  "real Chrome learns a site from a passively recorded open tab and a closed tab",
  { skip: missingChrome() },
  async () => {
    const open = await site();
    const closed = await site();
    const stack = await startBridgeChrome("learn-real");
    try {
      const kept = await stack.repl(
        `const page = await browser.openTab(${JSON.stringify(open.base + "/app")}); await page.waitFor(() => window.__done, { timeout: 30000 }); console.log("OPEN ok");`,
      );
      assert.match(kept.stdout, /OPEN ok/, kept.stdout + kept.stderr);
      checkModel(await model(stack, open.host));

      const gone = await stack.repl(
        `let page; try { page = await browser.openTab(${JSON.stringify(closed.base + "/app")}); await page.waitFor(() => window.__done, { timeout: 30000 }); } finally { await browser.closeTab(page); } console.log("CLOSED ok");`,
      );
      assert.match(gone.stdout, /CLOSED ok/, gone.stdout + gone.stderr);
      checkModel(await model(stack, closed.host));
    } finally {
      await stack.stop();
      open.server.close();
      closed.server.close();
    }
  },
);
