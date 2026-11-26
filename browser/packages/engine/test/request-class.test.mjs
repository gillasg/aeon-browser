import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest, isApiLikeClass, classFilter } from "../dist/request-class.js";
import { isTrackerUrl, takeLearned } from "../dist/native-browser-network-learn.js";
import { listEntries } from "../dist/native-browser-network-list.js";

const SENSOR_BODY = JSON.stringify({ sensor_data: "3;0;1;0;" + "Zx9Qk2Lw".repeat(60) });

// [expected, facts] from recorded site dossiers.
const CASES = [
  [
    "challenge",
    { url: "https://www.booking.com/__challenge_h78IRKXab/inputs", type: "Fetch", method: "POST" },
  ],
  ["challenge", { url: "https://www.booking.com/__challenge_h78IRKXab/verify", type: "XHR" }],
  [
    "challenge",
    {
      url: "https://anilist.co/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1",
      type: "Script",
    },
  ],
  [
    "challenge",
    {
      url: "https://www.discogs.com/cdn-cgi/challenge-platform/h/g/jsd/r/abc",
      type: "XHR",
      method: "POST",
    },
  ],
  ["challenge", { url: "https://challenges.cloudflare.com/turnstile/v0/api.js", type: "Script" }],
  [
    "challenge",
    {
      url: "https://www.notion.so/.well-known/vercel/security/request-challenge",
      type: "Fetch",
      method: "POST",
    },
  ],
  [
    "challenge",
    {
      url: "https://polymarket.com/.well-known/vercel/security/static/challenge.v2.min.js",
      type: "Script",
    },
  ],
  ["challenge", { url: "https://www.example-shop.com/akam/13/7f3a1b2c", type: "Script" }],
  ["challenge", { url: "https://www.example-shop.com/ips.js?x=1", type: "Script" }],
  [
    "challenge",
    { url: "https://geo.captcha-delivery.com/captcha/?initialCid=1", type: "Document" },
  ],
  ["challenge", { url: "https://client.px-cloud.net/PXabc/main.min.js", type: "Script" }],
  [
    "sensor",
    {
      url: "https://www.flipkart.com/jGynxk/snk/aBcDeF",
      type: "XHR",
      method: "POST",
      postData: SENSOR_BODY,
    },
  ],
  ["sensor", { url: "https://d0a7e.airbnb.com/js/abc", type: "XHR", method: "POST" }],
  ["sensor", { url: "https://k.twitchcdn.net/149/mfc", type: "XHR", method: "POST" }],
  [
    "sensor",
    {
      url: "https://www.shop.com/Xq7KzTpRw/QmZbVnLk",
      type: "XHR",
      method: "POST",
      postData: "x".repeat(10) + "Zq9".repeat(100),
    },
  ],
  ["beacon", { url: "https://www.goodreads.com/book/show/1", type: "Ping", method: "POST" }],
  ["beacon", { url: "https://www.goodreads.com/weblab", type: "XHR", method: "POST" }],
  [
    "beacon",
    {
      url: "https://1.rome.api.flipkart.com/api/1/sonic/data/collector",
      type: "XHR",
      method: "POST",
    },
  ],
  [
    "beacon",
    {
      url: "https://unagi.amazon.com/1/events/com.amazon.csm.csa.prod",
      type: "Fetch",
      method: "POST",
    },
  ],
  [
    "beacon",
    { url: "https://www.airbnb.com/tracking/jitney/logging", type: "XHR", method: "POST" },
  ],
  ["beacon", { url: "https://fundingchoicesmessages.google.com/i/pub-123", type: "Script" }],
  ["tracker", { url: "https://www.google-analytics.com/g/collect?v=2", type: "Ping" }],
  [
    "tracker",
    { url: "https://o1.ingest.sentry.io/api/1/envelope/", type: "Fetch", method: "POST" },
  ],
  ["tracker", { url: "https://example.com/api/telemetry", type: "Fetch" }],
  [
    "media",
    {
      url: "https://video.akamai.steamstatic.com/store_trailers/1/dash_av1.mpd?t=1",
      type: "XHR",
      mime: "application/dash+xml",
    },
  ],
  [
    "media",
    {
      url: "https://video.akamai.steamstatic.com/store_trailers/1/chunk-stream0-00001.m4s",
      type: "XHR",
      mime: "video/mp4",
    },
  ],
  [
    "media",
    {
      url: "https://cdn.example.com/live/master.m3u8",
      type: "XHR",
      mime: "application/vnd.apple.mpegurl",
    },
  ],
  ["media", { url: "https://cdn.example.com/live/seg001.ts", type: "XHR", mime: "video/mp2t" }],
  [
    "media",
    { url: "https://t4.bcbits.com/stream/abc/mp3-128/1", type: "Media", mime: "audio/mpeg" },
  ],
  ["asset", { url: "https://s4.bcbits.com/img/fastly-logo.png", type: "Fetch", mime: "image/png" }],
  [
    "asset",
    { url: "https://fonts.gstatic.com/s/inter/v12/a.woff2", type: "Font", mime: "font/woff2" },
  ],
  ["asset", { url: "https://cdn.example.com/app.css", type: "Stylesheet", mime: "text/css" }],
  [
    "asset",
    { url: "https://cdn.example.com/module.wasm", type: "Fetch", mime: "application/wasm" },
  ],
  [
    "asset",
    { url: "https://cdn.example.com/app.js", type: "Script", mime: "application/javascript" },
  ],
  [
    "document",
    { url: "https://en.wikipedia.org/wiki/Dieter_Rams", type: "Document", mime: "text/html" },
  ],
  ["api", { url: "https://www.example.com/fragment/cart", type: "Fetch", mime: "text/html" }],
  [
    "api",
    {
      url: "https://bandcamp.com/api/discover/1/discover_web",
      type: "XHR",
      method: "POST",
      mime: "application/json",
      postData: '{"category_id":0,"slice":"top","size":60}',
    },
  ],
  [
    "api",
    {
      url: "https://en.wikipedia.org/api/rest_v1/page/summary/Dieter_Rams",
      type: "Fetch",
      mime: "application/json",
    },
  ],
  [
    "api",
    {
      url: "https://api.lu.ma/discover/get-paginated-events?pagination_limit=25",
      type: "Fetch",
      mime: "application/json",
    },
  ],
  [
    "api",
    {
      url: "https://www.example.com/search?callback=cb123&q=x",
      type: "Script",
      mime: "application/javascript",
    },
  ],
  [
    "graphql",
    {
      url: "https://graphql.anilist.co/",
      type: "Fetch",
      method: "POST",
      mime: "application/json",
      postData: '{"query":"query { Page { media { id } } }"}',
    },
  ],
  [
    "graphql",
    { url: "https://gql.twitch.tv/gql", type: "Fetch", method: "POST", mime: "application/json" },
  ],
  ["graphql", { url: "https://client-api.linear.app/graphql", type: "Fetch", method: "POST" }],
  [
    "graphql",
    {
      url: "https://api.example.com/v1/data",
      type: "Fetch",
      method: "POST",
      postData: '{"operationName":"Feed","variables":{}}',
    },
  ],
];

for (const [expected, facts] of CASES) {
  test(`classifyRequest: ${expected} ← ${facts.type ?? ""} ${facts.url}`, () => {
    assert.equal(classifyRequest(facts), expected);
  });
}

test("isApiLikeClass is api and graphql only", () => {
  assert.equal(isApiLikeClass("api"), true);
  assert.equal(isApiLikeClass("graphql"), true);
  for (const cls of ["tracker", "challenge", "sensor", "media", "asset", "beacon", "document"])
    assert.equal(isApiLikeClass(cls), false);
});

test("classFilter accepts one class or a list and ignores unknown names", () => {
  assert.equal(classFilter(undefined), undefined);
  assert.equal(classFilter("nonsense"), undefined);
  const filter = classFilter(["api", "graphql"]);
  assert.equal(filter("api"), true);
  assert.equal(filter("media"), false);
});

test("isTrackerUrl is still exported from the learning module", () => {
  assert.equal(isTrackerUrl("https://www.googletagmanager.com/gtm.js"), true);
  assert.equal(isTrackerUrl("https://example.com/api/items"), false);
});

function entry(id, url, extra = {}) {
  return {
    id,
    url,
    method: "GET",
    type: "Fetch",
    startedAt: 1,
    requestHeaders: {},
    done: true,
    status: 200,
    ...extra,
  };
}

const NOISY = [
  entry("1", "https://www.booking.com/__challenge_h78IRKX/inputs", {
    method: "POST",
    mimeType: "application/json",
  }),
  entry("2", "https://video.steamstatic.com/t/dash_av1.mpd", { mimeType: "application/dash+xml" }),
  entry("3", "https://s4.bcbits.com/img/fastly-logo.png", { mimeType: "image/png" }),
  entry("4", "https://www.goodreads.com/book/show/1", { type: "Ping", method: "POST" }),
  entry("5", "https://example.com/api/items?page=1", { mimeType: "application/json" }),
];

test("takeLearned keeps only api and graphql calls", () => {
  const recorder = { entries: new Map(NOISY.map((item) => [item.id, item])), bodyBytes: 0 };
  const har = takeLearned(recorder);
  assert.deepEqual(
    har.log.entries.map((item) => item.request.url),
    ["https://example.com/api/items?page=1"],
  );
});

test("network list entries carry class and filter by it", () => {
  const rows = listEntries(NOISY, {});
  assert.deepEqual(
    rows.map((row) => row.class),
    ["challenge", "media", "asset", "beacon", "api"],
  );
  assert.deepEqual(
    listEntries(NOISY, { class: "api" }).map((row) => row.id),
    ["5"],
  );
  assert.deepEqual(
    listEntries(NOISY, { class: ["media", "asset"] }).map((row) => row.id),
    ["2", "3"],
  );
});
