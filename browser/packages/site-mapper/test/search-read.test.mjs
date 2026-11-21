import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteModel } from "../dist/index.js";

function exchange(over) {
  return {
    id: "1",
    source: "live",
    startedAt: 1,
    method: "POST",
    requestHeaders: { "content-type": "application/json" },
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    responseMime: "application/json",
    resourceType: "fetch",
    ...over,
  };
}

test("a search page fetch is a callable read of product, price and link", async () => {
  const { model } = await buildSiteModel(
    [
      exchange({
        url: "https://1.rome.api.flipkart.com/api/4/page/fetch?cacheFirst=false",
        pageUrl: "https://www.flipkart.com/search?q=PlayStation+5",
        requestBody: JSON.stringify({
          pageUri: "/search?q=PlayStation+5&sort=price_asc",
          pageContext: { fetchSeoData: false },
          requestContext: { type: "BROWSE_PAGE" },
        }),
        responseBody: JSON.stringify({
          RESPONSE: {
            slots: [
              {
                widget: {
                  data: {
                    products: [
                      {
                        titles: { title: "PS5 Console" },
                        pricing: { finalPrice: { currency: "INR", decimalValue: "44990" } },
                        url: "https://www.flipkart.com/sony-ps5-console/p/itm123",
                      },
                    ],
                  },
                },
              },
            ],
          },
        }),
      }),
      exchange({
        id: "2",
        url: "https://shop.example/api/cart/add",
        requestBody: JSON.stringify({ sku: "ps5" }),
        responseBody: JSON.stringify({ ok: true }),
      }),
    ],
    { site: "flipkart.com" },
  );
  const search = model.operations.find((op) => op.path === "/api/4/page/fetch");
  const write = model.operations.find((op) => op.path === "/api/cart/add");
  assert.ok(search, model.operations.map((op) => op.path).join(","));
  assert.equal(search.role, "read");
  assert.ok(search.capabilities?.includes("search"), JSON.stringify(search.capabilities));
  assert.ok(search.capabilities?.includes("price"), JSON.stringify(search.capabilities));
  assert.match(search.samples[0].responseBody, /PS5 Console/);
  assert.match(search.samples[0].responseBody, /\/p\/itm123/);
  assert.equal(write.role, "action");
  assert.equal(write.capabilities, undefined);
});
