// Real Chrome, a real local site. 1) A persisted GraphQL hash rotates in the bundle and in the
// path; the next call heals from the bundle read inside the page it was learned on (a non-root
// page), answers in the same call with an enumerable `healed`, saves over the same id, and Node
// never fetches the bundle (the server logs every bundle request's user agent). 2) A write is
// proven once in the page, then repeated through the API.
// Run alone: node --test packages/site-mapper/test/heal-real.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingChrome, startBridgeChrome } from "../../../test/helpers/bridge-chrome.mjs";

const APP = (hash) => `
const H = ${JSON.stringify(hash)};
(async () => {
  for (const q of ['paris', 'rome']) {
    const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: H } }));
    await fetch('/gql/AutoSuggest/' + H + '?operationName=AutoSuggest&variables=' + encodeURIComponent(JSON.stringify({ query: q })) + '&extensions=' + ext).then((r) => r.json());
  }
  window.__done = true;
})();`;

const PAGE = `<!doctype html><title>Search</title><h1>Search</h1><script src="/assets/app.js"></script>`;
const EDIT = `<!doctype html><title>Item</title><input id="name" value="Lamp"><button id="rename">Rename</button>
<script>document.getElementById('rename').onclick = async () => {
  await fetch('/api/items/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value }) });
  window.__renamed = true;
};</script>`;

// The home page has no bundle: the heal must read the page the operation was learned on.
const HOME = "<!doctype html><title>Home</title><h1>Home</h1>";

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function suggest(state, hash, url) {
  const ext = JSON.parse(url.searchParams.get("extensions") ?? "{}");
  if (hash !== state.hash || ext.persistedQuery?.sha256Hash !== state.hash)
    return { errors: [{ message: "PersistedQueryNotFound" }] };
  const v = JSON.parse(url.searchParams.get("variables") ?? "{}");
  return { data: { suggestions: [{ name: `${v.query} city` }] } };
}

function site() {
  const state = { hash: "a".repeat(64), bundleAgents: [], writes: [] };
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const pages = { "/": HOME, "/shop/search": PAGE, "/shop/item": EDIT };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    const p = url.pathname;
    if (pages[p] !== undefined) {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(pages[p]);
    }
    if (p === "/assets/app.js") {
      state.bundleAgents.push(String(request.headers["user-agent"] ?? ""));
      response.writeHead(200, { "content-type": "application/javascript" });
      return response.end(APP(state.hash));
    }
    const gql = /^\/gql\/AutoSuggest\/([a-f0-9]{64})$/.exec(p);
    if (gql) return json(response, 200, suggest(state, gql[1], url));
    if (p === "/api/items/1" && request.method === "PATCH") {
      state.writes.push({
        body: await bodyOf(request),
        agent: String(request.headers["user-agent"]),
      });
      return json(response, 200, { id: 1, ok: true });
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      done({ base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, server, state });
    }),
  );
}

const line = (out, label) => {
  const match = new RegExp(`^${label} (.*)$`, "m").exec(out);
  return match ? JSON.parse(match[1]) : undefined;
};

async function savedModel(stack, host) {
  const path = join(stack.env.SITE_TO_API_HOME, "sites", host.replace(":", "_"), "model.json");
  return JSON.parse(await readFile(path, "utf8"));
}

const callCell = (host, query) =>
  `let out; try { out = await siteMapper.call(${JSON.stringify(host)}, "autoSuggest", { variables: { query: ${JSON.stringify(query)} } }); } catch (e) { out = { THREW: String(e.message) }; } console.log("RES " + JSON.stringify(out));`;

test(
  "a rotated hash heals from the bundle read inside its page, with no Node fetch of the bundle",
  { skip: missingChrome() },
  async () => {
    const shop = await site();
    const stack = await startBridgeChrome("heal-real");
    try {
      const learn = await stack.repl(
        `let page; try { page = await browser.openTab(${JSON.stringify(shop.base + "/shop/search")}); await page.waitFor(() => window.__done, { timeout: 30000 }); } finally { await browser.closeTab(page); } console.log("LEARNED ok");`,
      );
      assert.match(learn.stdout, /LEARNED ok/, learn.stdout + learn.stderr);
      const before = await savedModel(stack, shop.host);
      const ids = before.operations.filter((op) => op.kind === "graphql").map((op) => op.id);
      assert.deepEqual(ids, ["autoSuggest"], JSON.stringify(ids));

      shop.state.hash = "c".repeat(64);
      const first = line((await stack.repl(callCell(shop.host, "lima"))).stdout, "RES");
      assert.deepEqual(first.data, { suggestions: [{ name: "lima city" }] }, JSON.stringify(first));
      assert.equal(first.healed.from, `AutoSuggest@${"a".repeat(64)}`);
      assert.equal(first.healed.to, `AutoSuggest@${"c".repeat(64)}`);
      assert.ok(Date.parse(first.healed.at));

      const again = line((await stack.repl(callCell(shop.host, "kyiv"))).stdout, "RES");
      assert.deepEqual(again.data, { suggestions: [{ name: "kyiv city" }] }, JSON.stringify(again));
      assert.equal(again.healed, undefined);

      const after = await savedModel(stack, shop.host);
      const graphql = after.operations.filter((op) => op.kind === "graphql");
      assert.deepEqual(
        graphql.map((op) => op.id),
        ["autoSuggest"],
        "saved over the same id, no twin",
      );
      assert.match(graphql[0].path, /c{64}$/);
      assert.equal(graphql[0].graphql.extensions.persistedQuery.sha256Hash, "c".repeat(64));

      assert.ok(shop.state.bundleAgents.length > 0);
      for (const agent of shop.state.bundleAgents)
        assert.match(agent, /Chrome\//, `a bundle request did not come from the page: ${agent}`);
    } finally {
      await stack.stop();
      shop.server.close();
    }
  },
);

test(
  "a write proven once in the page is then repeated through the API",
  { skip: missingChrome() },
  async () => {
    const shop = await site();
    const stack = await startBridgeChrome("heal-real-proof");
    try {
      const proof = await stack.repl(
        `const page = await browser.openTab(${JSON.stringify(shop.base + "/shop/item")}); await page.getByRole("button", { name: "Rename" }).click(); await page.waitFor(() => window.__renamed, { timeout: 15000 }); console.log("PROVED ok");`,
      );
      assert.match(proof.stdout, /PROVED ok/, proof.stdout + proof.stderr);
      const ops = (await savedModel(stack, shop.host)).operations;
      const rename = ops.find((op) => op.method === "PATCH");
      assert.ok(rename, JSON.stringify(ops.map((op) => op.id)));
      const write = await stack.repl(
        `let out; try { out = await siteMapper.write(${JSON.stringify(shop.host)}, ${JSON.stringify(rename.id)}, { itemId: "1", name: "Desk lamp" }); } catch (e) { out = { THREW: String(e.message) }; } console.log("RES " + JSON.stringify(out));`,
      );
      const result = line(write.stdout, "RES");
      assert.deepEqual(result, { id: 1, ok: true }, write.stdout + write.stderr);
      assert.equal(shop.state.writes.length, 2, JSON.stringify(shop.state.writes));
      assert.equal(JSON.parse(shop.state.writes[1].body).name, "Desk lamp");
    } finally {
      await stack.stop();
      shop.server.close();
    }
  },
);
