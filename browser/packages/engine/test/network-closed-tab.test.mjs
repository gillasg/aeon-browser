import assert from "node:assert/strict";
import test from "node:test";

const { keepClosedTab, takeClosedTabs } = await import("../dist/native-browser-network-closed.js");

function entry(id, url) {
  return {
    id,
    url,
    method: "GET",
    type: "Fetch",
    status: 200,
    mimeType: "application/json",
    done: true,
    startedAt: Date.now(),
    requestHeaders: { accept: "application/json", cookie: "sid=secret" },
    responseHeaders: { "content-type": "application/json" },
    body: '{"items":[1,2]}',
  };
}

test("a tab closed inside a cell keeps its recorded calls for end-of-cell learning", () => {
  const recorder = {
    entries: new Map([["1", entry("1", "https://shop.test/api/search?q=shoes")]]),
    passive: true,
    bodyBytes: 15,
  };
  keepClosedTab(41, recorder);
  // Another cell's tab is never handed over.
  assert.deepEqual(takeClosedTabs([99]), []);
  const [kept] = takeClosedTabs([41]);
  assert.equal(kept.tabId, 41);
  assert.equal(kept.url, "https://shop.test/api/search?q=shoes");
  const entries = kept.har.log.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].request.url, "https://shop.test/api/search?q=shoes");
  assert.ok(!entries[0].request.headers.some((h) => h.name.toLowerCase() === "cookie"));
  // Handed over once.
  assert.deepEqual(takeClosedTabs([41]), []);
});

test("a closed tab with nothing new recorded keeps nothing", () => {
  keepClosedTab(42, { entries: new Map(), bodyBytes: 0 });
  keepClosedTab(43, undefined);
  assert.deepEqual(takeClosedTabs([42, 43]), []);
});
