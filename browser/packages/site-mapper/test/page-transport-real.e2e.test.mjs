// The page transport against real Chrome and a real local site: a cookie session, a
// <meta name=csrf-token>, an x-api-key the page's own code keeps in memory, and a token from
// /api/token sent back as a bearer. All four must reach the site raw, and nothing on the wire
// may say graft-sealed or carry a Graft user agent. No mocked page.
// Run alone: node --test packages/site-mapper/test/page-transport-real.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { canLaunch, launchProduct } from "../../../test/helpers/product-launch.mjs";

const SESSION = "sess-7d1f0c9b2a4e";
const CSRF = "csrf-91ab3c77e2f0";
const KEY = "key-5e2d8a01b9c4";
const TOKEN = "tok-3f9a1c0d7e6b52";

const html = `<!doctype html><meta name="csrf-token" content="${CSRF}"><title>Shop</title><h1>Shop</h1>
<script>
  // The site's code keeps its API key in memory and sends it on its own calls.
  const apiKey = ${JSON.stringify(KEY)};
  fetch("/api/ping", { headers: { "x-api-key": apiKey } });
</script>`;

function site(log) {
  return createServer((request, response) => {
    log.push({ url: request.url, headers: request.headers });
    const cookie = request.headers.cookie ?? "";
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/") {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": `sid=${SESSION}; HttpOnly; Path=/; SameSite=Lax`,
      });
      return response.end(html);
    }
    if (request.url === "/api/ping") return json(200, { ok: true });
    if (!cookie.includes(`sid=${SESSION}`)) return json(401, { error: "signed out" });
    if (request.url === "/api/token") return json(200, { token: TOKEN });
    const h = request.headers;
    const ok =
      h["x-csrf-token"] === CSRF && h["x-api-key"] === KEY && h.authorization === `Bearer ${TOKEN}`;
    return json(ok ? 200 : 403, { ok, items: ok ? [1, 2, 3] : [] });
  });
}

test(
  "a page call carries the session, CSRF, in-memory key and bearer raw, and nothing of Graft",
  { skip: !process.env.REQUIRE_E2E && !canLaunch },
  async () => {
    const log = [];
    const server = site(log);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const home = `http://127.0.0.1:${server.address().port}/`;
    const product = await launchProduct();
    process.env.BROWSERKIT_HOME = product.home;
    const { PageTransport, closeSharedBridge } = await import("../dist/runtime/index.js");
    try {
      const page = new PageTransport();
      assert.equal(await page.connected(), true);
      const context = { auth: [], home };
      const request = (path, headers = {}, extra = {}) => ({
        url: new URL(path, home).href,
        method: "GET",
        headers: { accept: "application/json", ...headers },
        ...extra,
      });
      const token = await page.send(request("/api/token"), context);
      assert.equal(token.status, 200);
      // The token reaches Node sealed: the cell and the agent never hold it raw.
      assert.match(token.json.token, /^graft-sealed:/);
      const data = await page.send(
        request(
          "/api/items",
          { authorization: `Bearer ${token.json.token}` },
          {
            pageHeaders: ["x-csrf-token"],
          },
        ),
        context,
      );
      assert.equal(data.status, 200, JSON.stringify(log.at(-1)?.headers));
      const sent = log.find((entry) => entry.url === "/api/items").headers;
      assert.equal(sent.cookie.includes(`sid=${SESSION}`), true);
      assert.equal(sent["x-csrf-token"], CSRF);
      assert.equal(sent["x-api-key"], KEY);
      assert.equal(sent.authorization, `Bearer ${TOKEN}`);
      assert.equal(sent["sec-fetch-site"], "same-origin");
      assert.equal(sent.referer?.startsWith(home), true);
      const wire = JSON.stringify(log);
      assert.doesNotMatch(wire, /graft-sealed/);
      assert.doesNotMatch(wire, /graft|aeon|browserkit/i);
      for (const entry of log) assert.match(entry.headers["user-agent"] ?? "", /Chrome\//);
    } finally {
      await closeSharedBridge();
      await product.close();
      server.close();
    }
  },
  { timeout: 180_000 },
);
