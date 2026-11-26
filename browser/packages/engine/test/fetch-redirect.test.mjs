// browser.fetch in an MV3 worker: every redirect is opaque. With an Aeon tab on the origin the
// request moves into it and the final address is checked before the body is returned; with no
// tab it is refused with the way out.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const store = { "private-network": false, "private-network-ports": [] };
const tabs = [];
globalThis.chrome = {
  storage: { local: { get: async (key) => ({ [key]: store[key] }) } },
  tabs: { query: async () => tabs },
  scripting: {
    // The page realm: no document here, so the helper falls back to the global fetch.
    executeScript: async ({ func, args }) => [{ result: await func(...args) }],
  },
};
const { fetchCall } = await import("../dist/native-browser-fetch.js");
const { setFetchTabOwner } = await import("../dist/native-browser-fetch-tab.js");
setFetchTabOwner((tabId) => tabId === 9);

// The MV3 worker's view: manual redirects come back opaque, without a Location.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const response = await realFetch(url, init);
  if (init.redirect !== "manual" || response.status < 300 || response.status > 399) return response;
  await response.body?.cancel();
  return { type: "opaqueredirect", status: 0, headers: new Headers(), body: null };
};

async function server(handler) {
  const http = createServer(handler);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { http, port: http.address().port, base: `http://127.0.0.1:${http.address().port}` };
}

test("with no Aeon tab on the origin the redirect is refused with the way out", async () => {
  const site = await server((req, res) =>
    req.url === "/a" ? res.writeHead(302, { location: "/b" }).end() : res.end("B"),
  );
  tabs.length = 0;
  try {
    await assert.rejects(
      fetchCall({ fetch: { url: `${site.base}/a` } }),
      new RegExp(
        `^Error: REDIRECT_UNCHECKED.*open the site once, or fetch ${site.base}/a with page\\.request`,
      ),
    );
  } finally {
    site.http.close();
  }
});

test("with an Aeon tab on the origin the request follows inside it", async () => {
  const site = await server((req, res) =>
    req.url === "/a" ? res.writeHead(302, { location: "/b" }).end() : res.end('{"page":"b"}'),
  );
  tabs.splice(
    0,
    tabs.length,
    { id: 4, url: `${site.base}/x` },
    { id: 9, url: `${site.base}/home` },
  );
  try {
    const result = await fetchCall({ fetch: { url: `${site.base}/a` } });
    assert.equal(result.via, "tab");
    assert.equal(result.redirected, true);
    assert.ok(result.finalUrl.endsWith("/b"));
    assert.deepEqual(result.json, { page: "b" });
    const direct = await fetchCall({ fetch: { url: `${site.base}/b` } });
    assert.equal(direct.via, "worker");
    assert.equal(direct.redirected, undefined);
  } finally {
    site.http.close();
  }
});

test("a tab-followed redirect to a private address is refused and its body discarded", async () => {
  const inside = await server((_req, res) => res.end("router admin"));
  const site = await server((_req, res) =>
    res.writeHead(302, { location: `${inside.base}/admin` }).end(),
  );
  tabs.splice(0, tabs.length, { id: 9, url: `${site.base}/` });
  store["private-network"] = true;
  store["private-network-ports"] = [site.port];
  try {
    await assert.rejects(fetchCall({ fetch: { url: `${site.base}/a` } }), (error) => {
      assert.match(error.message, /^PRIVATE_NETWORK/);
      assert.ok(error.message.includes(`${inside.base}/admin`));
      assert.ok(!error.message.includes("router admin"));
      return true;
    });
  } finally {
    store["private-network"] = false;
    site.http.close();
    inside.http.close();
  }
});
