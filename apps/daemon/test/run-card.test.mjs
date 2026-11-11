import assert from "node:assert/strict";
import test from "node:test";
import { buildRunCard, speedText } from "../dist/run-card.js";
import { fillRouteDraft } from "../dist/route-draft.js";

const base = {
  chatId: "chat",
  runId: "run",
  site: "shop.test",
  task: "orders",
};

test("speed lines name the path and the previous run", () => {
  assert.equal(speedText(400, "saved ability"), "0.4 s · saved ability");
  assert.equal(speedText(38000, "first time"), "38 s · first time");
  assert.equal(speedText(1100, "from memory", 38000), "1.1 s · from memory (was 38 s)");
  assert.equal(
    speedText(1100, "with a saved draft", 38000),
    "1.1 s · with a saved draft (was 38 s)",
  );
});

test("a card has the speed line, one learned item, fresh and get-all", () => {
  const card = buildRunCard({
    ...base,
    durationMs: 1100,
    previousMs: 38000,
    path: "from memory",
    fromMemory: true,
    partial: { have: 20, total: 143 },
    learned: { abilityId: "shop.test/orders", name: "orders", site: "shop.test" },
    routeId: "r1",
  });
  assert.equal(card.items.filter((item) => item.kind === "learned").length, 1);
  assert.deepEqual(
    card.items.filter((item) => item.kind === "offer").map((item) => item.action),
    ["fresh", "get-all"],
  );
  assert.equal(card.wrong.routeId, "r1");
  assert.match(card.items[0].text, /1\.1 s · from memory \(was 38 s\)/);
});

test("a draft run is not labelled from memory and does not offer fresh", () => {
  const card = buildRunCard({
    ...base,
    durationMs: 1100,
    previousMs: 38000,
    path: "with a saved draft",
  });
  assert.match(card.items[0].text, /with a saved draft \(was 38 s\)/);
  assert.equal(card.items[0].text.includes("from memory"), false);
  assert.equal(
    card.items.some((item) => item.kind === "offer" && item.action === "fresh"),
    false,
  );
});

test("declined offers, empty checks and ours errors are not cards", () => {
  const declined = buildRunCard({
    ...base,
    fromMemory: true,
    declined: ["fresh:shop.test:orders"],
  });
  assert.equal(declined, undefined);
  assert.equal(buildRunCard(base), undefined);
  assert.equal(
    buildRunCard({ ...base, ours: true, durationMs: 10, path: "first time" }),
    undefined,
  );
});

test("a long first run offers to learn the site and does not ask a question", () => {
  const card = buildRunCard({
    ...base,
    longFirstRun: true,
    durationMs: 130000,
    path: "first time",
  });
  const offer = card.items.find((item) => item.kind === "offer");
  assert.equal(offer.action, "learn-site");
  assert.equal(offer.text.includes("?"), false);
});

test("rung 1 fills routeDraft and rung 0 does not", () => {
  const route = {
    site: "shop.test",
    summary: "orders",
    cell: "await page.open()",
    lastOkAt: "2026-11-03T00:00:00.000Z",
  };
  assert.equal(fillRouteDraft(route, 0), undefined);
  assert.equal(fillRouteDraft(route, 1).cell, route.cell);
});
