import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { harvestCaptured, harvestReply } from "../dist/harvest.js";
import { pageGuard } from "../dist/page-guard.js";
import { rateLimitError, rateLimitWarning, THROTTLE_PAGE_JS } from "../dist/rate-limit.js";
import vm from "node:vm";
import { readGuard } from "../dist/read-guards.js";

const orders = JSON.stringify([
  { title: "Blue lamp", id: "ord-1" },
  { title: "Red kettle", id: "ord-2" },
]);

test("harvest keeps a JSON list whose fields are on the page", () => {
  const hit = harvestCaptured(
    [
      { url: "https://shop.example/api/orders", body: orders },
      {
        url: "https://shop.example/api/noise",
        body: JSON.stringify([{ title: "unseen row" }, { title: "also unseen" }]),
      },
    ],
    { visible: "Blue lamp\nRed kettle" },
  );
  assert.equal(hit.name, "orders");
  assert.equal(hit.count, 2);
  assert.equal(hit.rows[0].title, "Blue lamp");
});

test("harvest ignores a list that is not the one on screen", () => {
  const hit = harvestCaptured([{ url: "https://shop.example/api/orders", body: orders }], {
    visible: "Your cart is empty",
  });
  assert.equal(hit.count, 0);
});

test("page.data name returns those rows and the footer names the call", () => {
  const entries = [{ url: "https://shop.example/api/orders", body: orders }];
  const rows = harvestReply(entries, { visible: "Blue lamp Red kettle", name: "orders" });
  assert.equal(rows.count, 2);
  assert.match(rows.line, /\[data\] 2 orders already loaded by this page: page\.data\('orders'\)/);
  const footer = harvestReply(entries, { visible: "Blue lamp Red kettle", footer: true });
  assert.deepEqual(footer.rows, []);
  assert.match(footer.line, /page\.data\('orders'\)/);
  const other = harvestReply(entries, { visible: "Blue lamp Red kettle", name: "reviews" });
  assert.equal(other.count, 0);
});

test("a short rate-limit page warns once and a long page does not", () => {
  assert.match(rateLimitWarning("Too many requests. Try again later.", 200), /RATE_LIMITED/);
  assert.match(rateLimitWarning("ok", 429), /fewer tabs/);
  assert.match(rateLimitError("HTTP 429", 200), /RATE_LIMITED/);
  assert.match(rateLimitError("429 Too Many Requests", 200), /RATE_LIMITED/);
  assert.equal(rateLimitError("Coffee mug ₹429 in stock", 200, "Shop"), undefined);
  assert.equal(rateLimitError("Order total $429", 200, "Cart"), undefined);
  assert.equal(rateLimitError("429 items available", 200, "Catalog"), undefined);
  assert.equal(rateLimitWarning("a long page ".repeat(80), 200), undefined);
  const ctx = vm.createContext({});
  vm.runInContext(THROTTLE_PAGE_JS, ctx);
  assert.equal(vm.runInContext(`__throttlePage("Shop", "Coffee mug ₹429 in stock")`, ctx), "");
  assert.match(
    vm.runInContext(`__throttlePage("Error 429", "429 - slow down")`, ctx),
    /RATE_LIMITED/,
  );
});

test("an ordinary 429 on a page (price, order id, count) is not a rate limit", () => {
  for (const text of ["Order #429 shipped", "Total: $429.00", "429 results", "Item 14290"])
    assert.equal(rateLimitError(text, 200, "Shop"), undefined, text);
  for (const text of [
    "Error 429",
    "HTTP 429 Too Many Requests",
    "429 - rate limited",
    "status: 429",
  ])
    assert.match(rateLimitError(text, 200, ""), /RATE_LIMITED/, text);
  const page = new Function(`${THROTTLE_PAGE_JS}; return __throttlePage;`)();
  assert.equal(page("Shop", "Order #429 shipped"), "");
  assert.match(page("Error 429", "Too many requests"), /RATE_LIMITED/);
  assert.match(page("", "HTTP 429"), /RATE_LIMITED/);
});

test("rush-hour and heavy-traffic interstitials are RATE_LIMITED, not page content", () => {
  const amazon = "Oops! It's rush hour and traffic is piling up on that page.";
  const limited = rateLimitError(amazon, 503, "503 - Service Unavailable Error");
  assert.match(limited, /RATE_LIMITED/);
  assert.match(limited, /retry after a pause/);
  assert.match(limited, /fewer tabs/);
  const flipkart = "We're experiencing heavy traffic. Please wait a moment.";
  assert.match(rateLimitError(flipkart, 200, "Flipkart.com"), /RATE_LIMITED/);
  const catalog = `${amazon}\n${"PlayStation 5 console ₹49990 ".repeat(200)}`;
  assert.equal(rateLimitError(catalog, 200, "Amazon.in"), undefined);
  const guard = pageGuard({
    kind: "read",
    title: "503 - Service Unavailable Error",
    text: amazon,
    count: 0,
  });
  assert.match(String(guard.rateLimited), /not the site/);
  const context = vm.createContext({});
  vm.runInContext(THROTTLE_PAGE_JS, context);
  const page = vm.runInContext(
    `__throttlePage("503 - Service Unavailable Error", ${JSON.stringify(amazon)})`,
    context,
  );
  assert.match(page, /RATE_LIMITED/);
  const source = readFileSync(new URL("../src/code-api-data.ts", import.meta.url), "utf8");
  const read = source.slice(source.indexOf("read: async"));
  assert.ok(read.indexOf("__throttlePage") < read.indexOf("return result;"));
});

test("a read that contradicts itself, or shows a location, says so", () => {
  const guard = readGuard({ text: "9 orders\nDeliver to: Mumbai 400001", count: 0, shown: 0 });
  assert.equal(guard.contradiction, 'contradiction: "page says 9, list has 0"');
  assert.match(guard.location, /Mumbai/);
  const partial = readGuard({ text: "143 orders", count: 20, shown: 20 });
  assert.match(partial.partial, /list: 20 of 143 \(partial\)/);
  assert.equal(
    pageGuard({ kind: "read", text: "9 orders", count: 0 }).contradiction,
    'contradiction: "page says 9, list has 0"',
  );
});

test("harvest reads captured bodies before learning deletes them", () => {
  const source = readFileSync(new URL("../src/code-api-page.ts", import.meta.url), "utf8");
  const finish = source.slice(source.indexOf("async function __finishCell"));
  const harvestAt = finish.indexOf("__harvestFooter");
  const learnAt = finish.indexOf("__learnFromCell");
  assert.ok(
    harvestAt > 0 && learnAt > harvestAt,
    "harvest reads captured bodies before learning deletes them",
  );
});
