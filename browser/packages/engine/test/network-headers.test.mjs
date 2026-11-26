import assert from "node:assert/strict";
import test from "node:test";
import { localProxyHop, replaceHeaders } from "../dist/native-browser-network-headers.js";
import { READ_SEGMENT, classifyRequest } from "../dist/request-class.js";

test("early and late request headers with mixed case keep one value", () => {
  const early = { Referer: "https://a.test/", "x-platform": "web" };
  const late = { referer: "https://a.test/", "x-platform": "web" };
  const merged = replaceHeaders(early, late);
  assert.deepEqual(merged, { referer: "https://a.test/", "x-platform": "web" });
});

test("response headers: the extra-info copy replaces the base one whatever its case", () => {
  const base = { "Content-Type": "application/json", Referer: "https://a.test/" };
  const extra = { "content-type": "application/json", referer: "https://a.test/" };
  const merged = replaceHeaders(base, extra);
  assert.equal(Object.keys(merged).length, 2);
  assert.equal(merged["content-type"], "application/json");
});

test("a local SOCKS proxy hop is not a DNS-rebinding result", () => {
  assert.equal(localProxyHop("https://www.example.org/api", "127.0.0.1", 1081), true);
  assert.equal(localProxyHop("https://www.example.org/api", "127.0.0.1", 443), false);
  assert.equal(localProxyHop("http://localhost:1081/", "127.0.0.1", 1081), false);
  assert.equal(localProxyHop("https://www.example.org/api", "10.0.0.5", 1081), false);
});

test("one read-segment rule and the leaked noise hosts", () => {
  assert.ok(READ_SEGMENT.test("discover_web"));
  for (const url of [
    "https://token.awswaf.com/x",
    "https://id5-sync.com/i",
    "https://alb.reddit.com/rp.gif",
    "https://pixel-config.reddit.com/pixels/x",
    "https://m.stripe.network/inner.html",
    "https://r.stripe.com/b",
    "https://otel.example.com/v1/traces",
  ])
    assert.notEqual(classifyRequest({ url, type: "Fetch" }), "api", url);
});
