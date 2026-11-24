// browser.fetch follows redirects one hop at a time and checks each next address against the
// site policy before sending anything to it, so a 302 cannot carry the user's cookies to a
// site the user blocked.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

globalThis.chrome ??= { storage: { local: { get: async () => ({}) } } };
const { fetchCall } = await import("../dist/native-browser-fetch.js");
const { assertAllowed } = await import("../dist/native-browser-site-rules.js");

async function server(handler) {
  const http = createServer(handler);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { http, base: `http://127.0.0.1:${http.address().port}` };
}

test("a 302 to a blocked site throws SITE_BLOCKED before that site is asked", async () => {
  const seen = [];
  const blocked = await server((req, res) => {
    seen.push(req.url);
    res.end("secret");
  });
  const blockedHost = `localhost:${blocked.http.address().port}`;
  const open = await server((req, res) => {
    res.writeHead(302, { location: `http://${blockedHost}/api/accounts` });
    res.end();
  });
  const rules = { blocked: ["localhost"], only: [] };
  await assert.rejects(
    fetchCall({ fetch: { url: `${open.base}/r` } }, (next) => assertAllowed(rules, next)),
    /^Error: SITE_BLOCKED/,
  );
  assert.deepEqual(seen, []);
  open.http.close();
  blocked.http.close();
});

test("allowed redirects are still followed, hop by hop", async () => {
  const hops = [];
  const site = await server((req, res) => {
    hops.push(req.url);
    if (req.url === "/a") return res.writeHead(302, { location: "/b" }).end();
    if (req.url === "/b") return res.writeHead(307, { location: "/c" }).end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ done: true }));
  });
  const checked = [];
  const result = await fetchCall({ fetch: { url: `${site.base}/a` } }, (next) => {
    checked.push(new URL(next).pathname);
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { done: true });
  assert.deepEqual(hops, ["/a", "/b", "/c"]);
  assert.deepEqual(checked, ["/a", "/b", "/c"]);
  site.http.close();
});
