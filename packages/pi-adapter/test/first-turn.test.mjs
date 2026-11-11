import assert from "node:assert/strict";
import test from "node:test";
import { buildFirstTurn } from "../dist/first-turn.js";
import { tabFromCapture } from "../dist/first-turn-live.js";

const now = new Date("2026-11-10T09:02:00.000Z");

function turn(extra) {
  return buildFirstTurn({
    prompt: "show my orders",
    now,
    timeZone: "Asia/Kolkata",
    activeTab: { url: "https://www.shop.example/orders", title: "Orders" },
    openTabs: [{ host: "mail.example", title: "Inbox" }],
    abilities: [
      {
        site: "shop.example",
        name: "orders",
        call: "site.run('orders', {page})",
        score: 1,
        does: "read",
      },
    ],
    mappedReads: [{ site: "shop.example", name: "orders", inputs: ["page"] }],
    ...extra,
  });
}

test("a first turn matches the d8 lines and keeps page state short", () => {
  const text = turn();
  assert.match(text, /^\[now\] Tue 10 Nov 2026 14:32 IST\n/);
  assert.match(text, /\[page\] shop\.example · Orders\n/);
  assert.doesNotMatch(text, /the user is on this tab/);
  assert.match(text, /\[saved\] shop\.example: site\.run\('orders', \{page\}\)/);
  assert.match(text, /\[api\] shop\.example orders\(page\)/);
  assert.match(text, /\[tabs\] mail\.example · Inbox/);
  assert.match(text, /\n\nshow my orders$/);
});

test("a deictic prompt or the cursor includes the page state", () => {
  const deictic = turn({
    prompt: "fill this form",
    activeTab: { url: "https://shop.example/form", title: "Form", selection: "hello" },
  });
  assert.match(
    deictic,
    /shop\.example · Form — https:\/\/shop\.example\/form \(the user is on this tab\)/,
  );
  assert.match(deictic, /selection: "hello"/);
  assert.match(deictic, /Untrusted browser context/);
  assert.equal(tabFromCapture({ url: "https://shop.example/form", kind: "page" }).fromCursor, true);
  assert.equal(
    tabFromCapture({ url: "https://shop.example/form", kind: "selection", selectedText: "hello" })
      .fromCursor,
    true,
  );
  const cursor = turn({
    prompt: "go",
    activeTab: { url: "https://shop.example/form", title: "Form", fromCursor: true },
  });
  assert.match(cursor, /the user is on this tab/);
});

test("a route draft is its own line", () => {
  const text = turn({
    routeDraft: {
      site: "shop.example",
      summary: "open orders",
      cell: "page.read()",
      ranAt: "14:00",
    },
  });
  assert.match(text, /\[draft\] shop\.example: open orders \(14:00\)/);
});
