import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeRead } from "../dist/native-browser-dry-run.js";

const discover = JSON.stringify({
  category_id: 0,
  tag_norm_names: ["ambient"],
  slice: "best",
  cursor: "*",
  size: 24,
});

test("a filter-only POST to a discover endpoint is a read", () => {
  assert.equal(
    looksLikeRead("POST", "https://bandcamp.com/api/discover/1/discover_web", discover),
    true,
  );
  assert.equal(looksLikeRead("POST", "https://x.example/api/search", '{"q":"a","page":2}'), true);
});

test("write POSTs stay blocked in a dry run", () => {
  const cart = JSON.stringify({ item_id: 42, quantity: 1 });
  assert.equal(looksLikeRead("POST", "https://x.example/api/cart", cart), false);
  assert.equal(looksLikeRead("POST", "https://x.example/api/orders", "{}"), false);
  assert.equal(looksLikeRead("POST", "https://x.example/api/delete", "{}"), false);
  assert.equal(
    looksLikeRead("POST", "https://x.example/api/messages/send", '{"text":"hi"}'),
    false,
  );
  assert.equal(looksLikeRead("POST", "https://x.example/api/fan/2/collection_add", "{}"), false);
  // A read-looking path with a non-filter or mutating body is still blocked.
  assert.equal(looksLikeRead("POST", "https://x.example/api/search", cart), false);
  assert.equal(looksLikeRead("POST", "https://x.example/api/list", '{"q":"delete me"}'), false);
  assert.equal(looksLikeRead("POST", "https://x.example/api/list/add", '{"q":"a"}'), false);
  assert.equal(looksLikeRead("POST", "https://x.example/api/search", "not json"), false);
});
