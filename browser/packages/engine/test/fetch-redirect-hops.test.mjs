// Every redirect hop of browser.fetch is checked before it is sent: a public answer that points at
// the private network or a metadata address is refused without asking it, and a hop to another
// origin drops the caller's Authorization, Cookie and Proxy-Authorization headers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const store = { "private-network": false, "private-network-ports": [] };
globalThis.chrome = { storage: { local: { get: async (key) => ({ [key]: store[key] }) } } };
const { fetchCall } = await import("../dist/native-browser-fetch.js");

async function server(handler) {
  const http = createServer(handler);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { http, port: http.address().port, base: `http://127.0.0.1:${http.address().port}` };
}

test("a redirect to the private network is refused before the second hop is sent", async () => {
  const seen = [];
  const inside = await server((req, res) => {
    seen.push(req.url);
    res.end("router admin");
  });
  const targets = [`${inside.base}/admin`, "http://169.254.169.254/latest/meta-data/"];
  const open = await server((req, res) => {
    res.writeHead(302, { location: targets[Number(req.url.slice(1))] }).end();
  });
  store["private-network"] = true;
  store["private-network-ports"] = [open.port];
  try {
    for (const index of [0, 1]) {
      const hops = [];
      await assert.rejects(
        fetchCall({ fetch: { url: `${open.base}/${index}` } }, (next) => hops.push(next)),
        /^Error: PRIVATE_NETWORK/,
      );
      assert.deepEqual(hops, [`${open.base}/${index}`]);
    }
    assert.deepEqual(seen, []);
  } finally {
    store["private-network"] = false;
    open.http.close();
    inside.http.close();
  }
});

test("a hop to another origin drops credential headers, a same-origin hop keeps them", async () => {
  const received = [];
  const other = await server((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.end("ok");
  });
  const first = await server((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    if (req.url === "/start") return res.writeHead(302, { location: "/same" }).end();
    res.writeHead(307, { location: `${other.base}/away` }).end();
  });
  const result = await fetchCall({
    fetch: {
      url: `${first.base}/start`,
      method: "PUT",
      body: "payload",
      headers: {
        authorization: "Bearer secret",
        cookie: "session=1",
        "proxy-authorization": "Basic x",
        "x-kept": "yes",
      },
    },
  });
  assert.equal(result.status, 200);
  const [start, same, away] = received;
  assert.equal(start.url, "/start");
  assert.equal(same.headers.authorization, "Bearer secret");
  assert.equal(away.url, "/away");
  assert.equal(away.headers.authorization, undefined);
  assert.equal(away.headers.cookie, undefined);
  assert.equal(away.headers["proxy-authorization"], undefined);
  assert.equal(away.headers["x-kept"], "yes");
  first.http.close();
  other.http.close();
});

test("a 303 after a POST becomes a GET without the body", async () => {
  const received = [];
  const site = await server((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ method: req.method, body, type: req.headers["content-type"] });
      if (req.url === "/post") return res.writeHead(303, { location: "/done" }).end();
      res.end("done");
    });
  });
  await fetchCall({ fetch: { url: `${site.base}/post`, method: "POST", json: { a: 1 } } });
  assert.deepEqual(received[1], { method: "GET", body: "", type: undefined });
  site.http.close();
});
