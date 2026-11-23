import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHeaderEdits,
  applyHtmlOps,
  applyJsonOps,
  describeWireRule,
  fetchPatterns,
  isSignInUrl,
  matchingRules,
  rewriteResponse,
  sanitizeWireRule,
} from "../dist/native-browser-wire.js";
import { handlePaused, syncWireTab, wireTabs } from "../dist/native-browser-wire-tabs.js";

const json = (body) => ({ headers: [{ name: "content-type", value: "application/json" }], body });

test("wire rules match by URL glob and method, never on sign-in pages", () => {
  const rule = sanitizeWireRule({ match: "https://shop.test/api/*", action: "block" });
  assert.equal(matchingRules([rule], "https://shop.test/api/track?x=1").length, 1);
  assert.equal(matchingRules([rule], "https://shop.test/page").length, 0);
  const post = sanitizeWireRule({ match: "*", method: "post", action: "block" });
  assert.equal(matchingRules([post], "https://a.test/x", "GET").length, 0);
  assert.equal(matchingRules([post], "https://a.test/x", "POST").length, 1);
  for (const url of [
    "https://a.test/login",
    "https://a.test/account/password",
    "https://auth.a.test/x",
    "nope",
  ])
    assert.ok(isSignInUrl(url), url);
  assert.equal(matchingRules([rule], "https://shop.test/api/login").length, 0);
});

test("JSON transforms set, delete, filter and map without touching the input", () => {
  const data = {
    feed: [
      { id: 1, promoted: true },
      { id: 2, promoted: false, ad: "x" },
    ],
    meta: { upsell: 1 },
  };
  const out = applyJsonOps(data, [
    { op: "filter", path: "feed", where: { key: "promoted", equals: true }, keep: false },
    { op: "map", path: "feed", set: { seen: true }, delete: ["ad"] },
    { op: "delete", path: "meta.upsell" },
    { op: "set", path: "meta.clean", value: true },
    { op: "set", path: "__proto__", value: { polluted: 1 } },
  ]);
  assert.deepEqual(out, { feed: [{ id: 2, promoted: false, seen: true }], meta: { clean: true } });
  assert.equal(data.feed.length, 2);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(
    applyJsonOps(
      [1, { k: 1 }, { k: 2 }],
      [{ op: "filter", path: "", where: { key: "k", in: [2] } }],
    ),
    [{ k: 2 }],
  );
  assert.deepEqual(
    applyJsonOps({ a: [{ b: 1 }, { b: 2 }] }, [{ op: "set", path: "a.*.b", value: 0 }]),
    { a: [{ b: 0 }, { b: 0 }] },
  );
});

test("HTML ops inject markup and strip tags; scripts and handlers are refused", () => {
  const html = "<html><head></head><body><div class=promo>Buy</div><p>Hi</p></body></html>";
  const out = applyHtmlOps(html, [
    { op: "strip", tag: "div", contains: "buy" },
    { op: "inject", at: "body-end", html: "<aside>note</aside>" },
    { op: "inject", at: "head-end", html: "<style>p{}</style>" },
  ]);
  assert.equal(
    out,
    "<html><head><style>p{}</style></head><body><p>Hi</p><aside>note</aside></body></html>",
  );
  for (const bad of [
    "<script>x()</script>",
    "<img src=x onerror=alert(1)>",
    "<a href='javascript:x'>",
    "<iframe>",
  ])
    assert.equal(
      sanitizeWireRule({
        match: "*",
        action: "html",
        html: [{ op: "inject", at: "body-end", html: bad }],
      }),
      undefined,
      bad,
    );
});

test("auth headers and cookies are never changed, and descriptions carry no values", () => {
  const rule = sanitizeWireRule({
    match: "*",
    action: "headers",
    headers: [
      { name: "Set-Cookie" },
      { name: "authorization", value: "x" },
      { name: "x-frame-options" },
      { name: "x-boost", value: "1" },
    ],
  });
  assert.deepEqual(
    rule.headers.map((h) => h.name),
    ["x-frame-options", "x-boost"],
  );
  assert.equal(
    sanitizeWireRule({ match: "*", action: "headers", headers: [{ name: "Cookie" }] }),
    undefined,
  );
  const headers = [
    { name: "Set-Cookie", value: "sid=secret" },
    { name: "X-Frame-Options", value: "DENY" },
  ];
  const out = applyHeaderEdits(headers, [{ name: "set-cookie" }, ...rule.headers]);
  assert.deepEqual(out, [
    { name: "Set-Cookie", value: "sid=secret" },
    { name: "x-boost", value: "1" },
  ]);
  const text = describeWireRule(
    sanitizeWireRule({
      match: "https://a.test/x?token=secret",
      action: "headers",
      headers: [{ name: "x-a", value: "hidden" }],
    }),
  );
  assert.doesNotMatch(text, /secret|hidden/);
});

test("rewriteResponse edits matching bodies, drops stale length headers, and bypasses the rest", () => {
  const rule = sanitizeWireRule({
    match: "*",
    action: "json",
    json: [{ op: "delete", path: "ad" }],
  });
  const res = json('{"ad":1,"ok":true}');
  res.headers.push({ name: "content-length", value: "18" }, { name: "set-cookie", value: "a=b" });
  const out = rewriteResponse([rule], res);
  assert.equal(out.body, '{"ok":true}');
  assert.deepEqual(
    out.headers.map((h) => h.name),
    ["content-type", "set-cookie"],
  );
  assert.equal(rewriteResponse([], res), undefined);
  assert.equal(rewriteResponse([rule], json("not json")), undefined);
  assert.equal(
    rewriteResponse([rule], {
      headers: [{ name: "content-type", value: "text/html" }],
      body: '{"ad":1}',
    }),
    undefined,
  );
  assert.deepEqual(fetchPatterns([rule, rule, sanitizeWireRule({ match: "*", action: "block" })]), [
    { urlPattern: "*", requestStage: "Response" },
    { urlPattern: "*", requestStage: "Request" },
  ]);
});

function fakeChrome() {
  const calls = [];
  globalThis.chrome = {
    debugger: {
      attach: async () => calls.push(["attach"]),
      sendCommand: async (_t, method, params) => {
        calls.push([method, params]);
        if (method === "Fetch.getResponseBody")
          return { body: btoa('{"ad":1,"ok":1}'), base64Encoded: true };
        return {};
      },
      getTargets: async () => [],
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
    runtime: { lastError: undefined },
    tabs: { query: async () => [], get: async () => ({ url: "https://a.test/" }) },
  };
  return calls;
}

test("paused requests: blocks fail, matching responses are rewritten, others continue", async () => {
  const calls = fakeChrome();
  const debuggee = { tabId: 1 };
  const block = sanitizeWireRule({ match: "*/track*", action: "block" });
  const edit = sanitizeWireRule({
    match: "*/api*",
    action: "json",
    json: [{ op: "delete", path: "ad" }],
  });
  assert.equal(
    await handlePaused(debuggee, [block, edit], {
      requestId: "1",
      request: { url: "https://a.test/track" },
    }),
    "blocked",
  );
  assert.equal(
    await handlePaused(debuggee, [block, edit], {
      requestId: "2",
      request: { url: "https://a.test/other" },
    }),
    "continued",
  );
  const paused = {
    requestId: "3",
    request: { url: "https://a.test/api" },
    responseStatusCode: 200,
    responseHeaders: [{ name: "content-type", value: "application/json" }],
  };
  assert.equal(await handlePaused(debuggee, [block, edit], paused), "rewritten");
  const fulfilled = calls.find(([m]) => m === "Fetch.fulfillRequest")[1];
  assert.equal(atob(fulfilled.body), '{"ok":1}');
});

test("tabs without rules are never attached: zero overhead bypass", async () => {
  const calls = fakeChrome();
  await syncWireTab(5, "https://plain.test/");
  await syncWireTab(6, "https://a.test/login");
  assert.deepEqual(calls, []);
  assert.deepEqual(wireTabs(), []);
});
