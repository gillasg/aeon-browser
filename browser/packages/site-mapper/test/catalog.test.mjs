import assert from "node:assert/strict";
import test from "node:test";
import { catalogToolsForSite, inferEffect, searchCatalog } from "../dist/index.js";

test("catalog names keep the site and the operation id", () => {
  const taken = new Set();
  const [search, send, ability] = catalogToolsForSite(
    "amazon.in",
    {
      site: "amazon.in",
      operations: [
        { id: "searchProducts", method: "GET", path: "/s", summary: "Search", params: [] },
        {
          id: "sendOrder",
          method: "POST",
          path: "/order",
          summary: "Send the order",
          params: [],
        },
      ],
    },
    [
      {
        name: "searchProducts",
        description: "saved search",
        kind: "read",
        inputs: { properties: {} },
      },
    ],
    taken,
  );
  assert.equal(search.name, "site__amazon_in__searchProducts");
  assert.equal(search.effect, "read");
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(search.annotations.destructiveHint, false);
  assert.equal(send.effect, "irreversible");
  assert.equal(send.annotations.destructiveHint, true);
  assert.equal(ability.name, "site__amazon_in__searchProducts_ability");
  assert.equal(ability.kind, "ability");
  const found = searchCatalog([search, send, ability], "search products");
  assert.equal(found[0].id, "searchProducts");
});

test("effect inference treats irreversible words as stronger than GET", () => {
  assert.equal(inferEffect({ method: "GET", text: "checkout" }), "irreversible");
  assert.equal(inferEffect({ method: "POST", text: "create order" }), "write");
  assert.equal(inferEffect({ method: "GET", text: "list senders" }), "read");
  assert.equal(inferEffect({ method: "DELETE", text: "delete-account" }), "irreversible");
  assert.equal(inferEffect({ override: "read", method: "POST", text: "submit" }), "read");
  const taken = new Set();
  const [long] = catalogToolsForSite(
    "shop.example",
    {
      site: "shop.example",
      operations: [
        {
          id: "x".repeat(80),
          method: "GET",
          path: "/x",
          summary: "long",
          params: [],
        },
      ],
    },
    [],
    taken,
  );
  assert.ok(long.name.length <= 64, long.name);
  assert.match(long.name, /^site__shop_example__/);
});
