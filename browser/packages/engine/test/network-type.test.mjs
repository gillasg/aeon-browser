import assert from "node:assert/strict";
import test from "node:test";
import { listEntries } from "../dist/native-browser-network-list.js";
import { waitMatcher } from "../dist/native-browser-network-wait.js";

function entry(overrides) {
  return {
    id: "1",
    url: "https://example.test/api",
    method: "GET",
    type: "Fetch",
    startedAt: 1,
    requestHeaders: {},
    done: true,
    status: 200,
    ...overrides,
  };
}

const entries = [
  entry({ id: "json", mimeType: "application/json" }),
  entry({ id: "vendor", mimeType: "application/vnd.api+json", url: "https://example.test/vendor" }),
  entry({ id: "html", type: "Document", mimeType: "text/html", url: "https://example.test/" }),
  entry({ id: "png", type: "Image", mimeType: "image/png", url: "https://example.test/a.png" }),
  entry({ id: "jpeg", type: "Image", mimeType: "image/jpeg", url: "https://example.test/a.jpg" }),
  entry({ id: "xhr", type: "XHR", mimeType: "text/plain", url: "https://example.test/xhr" }),
];

function ids(type) {
  return listEntries(entries, { type }).map((row) => row.id);
}

test("page.network.list type filters by MIME as well as Chrome's resource type", () => {
  assert.deepEqual(ids("json").sort(), ["json", "vendor"]);
  assert.deepEqual(ids("+json"), ["vendor"]);
  assert.deepEqual(ids("html"), ["html"]);
  assert.deepEqual(ids("image/png"), ["png"]);
  assert.deepEqual(ids("image/").sort(), ["jpeg", "png"]);
  assert.deepEqual(ids("XHR"), ["xhr"]);
  assert.deepEqual(ids("Fetch").sort(), ["json", "vendor"]);
});

test("page.network.waitFor uses the same type filter", () => {
  const json = waitMatcher({ type: "json" });
  assert.equal(json(entries[0]), true);
  assert.equal(json(entries[2]), false);
  const png = waitMatcher({ match: "example.test", type: "image/png" });
  assert.equal(png(entries[3]), true);
  assert.equal(png(entries[4]), false);
});
