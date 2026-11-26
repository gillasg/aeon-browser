// site.pipe {to: {view}}: rows go to a live viewer on loopback, never to another host.
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import vm from "node:vm";
import { browserDemoClawsApi } from "../dist/code-api-demo-claws.js";
import { pipeViewTarget } from "../dist/native-browser-join.js";

function pipeContext() {
  const context = vm.createContext({
    setTimeout,
    URL,
    fetch,
    __helpTopics: {},
    __siteBase: {},
    __siteL2: {},
    site: {},
    browser: {},
    artifact: async () => undefined,
  });
  vm.runInContext(browserDemoClawsApi, context);
  return context;
}

test("pipeViewTarget takes only loopback http push URLs", () => {
  assert.equal(pipeViewTarget("http://127.0.0.1:9/").url, "http://127.0.0.1:9/push");
  assert.equal(pipeViewTarget({ url: "http://localhost:9/push", token: "t" }).token, "t");
  for (const url of [
    "https://127.0.0.1:9/push",
    "http://evil.test/push",
    "http://127.0.0.1.evil.test/push",
    "http://user:pw@127.0.0.1:9/push",
    "file:///tmp/x",
    "nope",
  ])
    assert.throws(() => pipeViewTarget({ url }), /INVALID_INPUT/, url);
});

test("site.pipe pushes rows to a localhost viewer with its token and refuses other hosts", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(req.headers.authorization === "Bearer secret" ? 200 : 401).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/push`;
  const context = pipeContext();
  context.target = { url, token: "secret", title: "Issues" };
  const result = await vm.runInContext(
    `site.pipe([{from: [{id: 1}, {id: 2}]}, {limit: 1}, {to: {view: target}}])`,
    context,
  );
  assert.equal(result.steps.at(-1).step, "to");
  assert.deepEqual(received, [
    { path: "/push", auth: "Bearer secret", body: { rows: [{ id: 1 }], title: "Issues" } },
  ]);
  context.target = { url, token: "wrong" };
  await assert.rejects(
    vm.runInContext(`site.pipe([{from: [1]}, {to: {view: target}}])`, context),
    /401/,
  );
  await assert.rejects(
    vm.runInContext(`site.pipe([{from: [1]}, {to: {view: 'http://evil.test/push'}}])`, context),
    /INVALID_INPUT/,
  );
  assert.equal(received.length, 2, "nothing was sent for the remote URL");
  server.close();
});
