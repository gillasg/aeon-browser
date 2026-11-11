import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { harvestCaptured, harvestReply } from "../dist/harvest.js";
import { pageGuard } from "../dist/page-guard.js";
import { rateLimitWarning } from "../dist/rate-limit.js";
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

test("a short rate-limit page warns once and does not suggest a retry", () => {
  assert.match(rateLimitWarning("Too many requests. Try again later.", 200), /RATE_LIMITED/);
  assert.match(rateLimitWarning("ok", 429), /report it/);
  assert.equal(rateLimitWarning("a long page ".repeat(80), 200), undefined);
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
