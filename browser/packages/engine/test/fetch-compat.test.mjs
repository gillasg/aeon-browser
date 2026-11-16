import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserFetchCompat } from "../dist/code-api.js";

// The manifest sandbox has an opaque origin, so its own fetch is CORS-bound. The compatibility
// shim must go through browser.fetch, which has the extension's host permissions, and still hand
// the cell a real Response.
test("the realm fetch goes through browser.fetch and builds a Response", async () => {
  const calls = [];
  const context = {
    browser: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          headers: { "content-type": "text/html" },
          text: "<h1>no cors needed</h1>",
        };
      },
    },
    Headers,
    Response,
  };
  context.globalThis = context;
  vm.runInNewContext(browserFetchCompat, context);

  const response = await context.fetch("http://127.0.0.1:8791/");
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("content-type"), "text/html");
  assert.equal(await response.text(), "<h1>no cors needed</h1>");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8791/");
  assert.equal(calls[0].init.method, undefined);
});
