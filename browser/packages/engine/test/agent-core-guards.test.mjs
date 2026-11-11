import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { harvestCaptured, harvestReply } from "../dist/harvest.js";
import {
  OFFICIAL_FORM_STOP,
  IRREVERSIBLE_STOP,
  officialSubmitStop,
  pageSignalsOfficial,
  taskAsksSubmit,
  unaskedIrreversible,
} from "../dist/official-form.js";
import { pageGuard } from "../dist/page-guard.js";
import { rateLimitWarning } from "../dist/rate-limit.js";
import { readGuard } from "../dist/read-guards.js";
import { budgetTabs, tabBudgetError, takeTabSlot } from "../dist/tab-budget.js";

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

test("the ninth agent tab is refused with the open tabs and the close call", () => {
  const open = [
    { id: 2, url: "https://new.test/", touched: 20 },
    { id: 9, url: "https://pool.test/", touched: 1, pool: true },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: index + 3,
      url: `https://s${index}.test/`,
      touched: 30 + index,
    })),
    { id: 1, url: "https://old.test/", touched: 10 },
  ];
  const message = tabBudgetError(open);
  assert.match(message, /^TAB_BUDGET:/);
  assert.match(message, /browser\.closeTab\(id\)/);
  assert.match(message, /Close the oldest first: 1 https:\/\/old\.test\//);
  assert.equal(
    budgetTabs(open).some((tab) => tab.url.includes("pool")),
    false,
  );
  assert.equal(tabBudgetError(open.slice(0, 7)), undefined);
});

test("parallel opens cannot overshoot the tab budget", async () => {
  const open = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    url: `https://s${index}.test/`,
    touched: index,
  }));
  async function openOne() {
    const slot = takeTabSlot("race-chat", open);
    await Promise.resolve();
    return slot;
  }
  const results = await Promise.all([openOne(), openOne()]);
  try {
    const refused = results.filter((slot) => slot.error);
    assert.equal(refused.length, 1);
    assert.match(refused[0].error ?? "", /TAB_BUDGET/);
    assert.match(refused[0].error ?? "", /Close the oldest first/);
  } finally {
    for (const slot of results) slot.release();
  }
  const full = [...open, { id: 8, url: "https://s8.test/", touched: 80 }];
  assert.equal(takeTabSlot("pool-chat", full, true).error, undefined);
  assert.match(takeTabSlot("pool-chat", full).error ?? "", /TAB_BUDGET/);
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
});

test("official forms are filled and left unsubmitted unless the task said to send them", () => {
  const filled = { label: "Submit", task: "fill in the visa form" };
  assert.equal(officialSubmitStop({ ...filled, host: "travel.state.gov" }), OFFICIAL_FORM_STOP);
  assert.equal(officialSubmitStop({ ...filled, host: "apply.university.edu" }), OFFICIAL_FORM_STOP);
  assert.equal(officialSubmitStop({ ...filled, host: "hr.workday.com" }), OFFICIAL_FORM_STOP);
  assert.equal(officialSubmitStop({ ...filled, host: "wd5.myworkday.com" }), OFFICIAL_FORM_STOP);
  assert.equal(officialSubmitStop({ ...filled, host: "secure.mybank.com" }), undefined);
  assert.equal(officialSubmitStop({ ...filled, host: "embankment.com" }), undefined);
  assert.equal(officialSubmitStop({ ...filled, host: "jobs.workday.example.com" }), undefined);
  assert.equal(officialSubmitStop({ ...filled, host: "my-bank.com" }), OFFICIAL_FORM_STOP);
  assert.equal(officialSubmitStop({ ...filled, host: "portal.insurance.com" }), OFFICIAL_FORM_STOP);
  assert.equal(
    officialSubmitStop({ ...filled, host: "jobs.example.com", pageText: "employee self-service" }),
    OFFICIAL_FORM_STOP,
  );
  assert.equal(
    officialSubmitStop({
      label: "Submit",
      task: "fill the form and submit",
      host: "travel.state.gov",
    }),
    undefined,
  );
  assert.equal(
    officialSubmitStop({ label: "Continue", task: "fill the form", host: "travel.state.gov" }),
    undefined,
  );
  assert.equal(
    officialSubmitStop({ label: "Place order", task: "buy the lamp", host: "shop.example" }),
    undefined,
  );
  assert.equal(
    officialSubmitStop({
      label: "Submit",
      task: "fill the form, don't submit",
      host: "shop.example",
    }),
    IRREVERSIBLE_STOP,
  );
  assert.equal(pageSignalsOfficial("your application"), false);
  assert.equal(pageSignalsOfficial("sign the declaration"), false);
  assert.equal(pageSignalsOfficial("I hereby declare the facts"), true);
  assert.equal(taskAsksSubmit("show my pay stub"), false);
  assert.equal(taskAsksSubmit("purchase history"), false);
  assert.equal(taskAsksSubmit("submit without a cover letter"), false);
  assert.equal(taskAsksSubmit("file my taxes"), true);
  assert.equal(taskAsksSubmit("send my application"), true);
  assert.equal(
    officialSubmitStop({
      label: "Submit",
      task: "submit without a cover letter",
      host: "travel.state.gov",
    }),
    OFFICIAL_FORM_STOP,
  );
  assert.equal(
    officialSubmitStop({
      label: "Submit",
      task: "submit without a cover letter",
      host: "shop.example",
    }),
    undefined,
  );
  assert.equal(
    officialSubmitStop({
      label: "Email",
      task: "fill the visa form",
      host: "travel.state.gov",
      fieldEnter: true,
    }),
    OFFICIAL_FORM_STOP,
  );
  assert.equal(
    officialSubmitStop({
      label: "Email",
      task: "file my taxes",
      host: "irs.gov",
      fieldEnter: true,
    }),
    undefined,
  );
  assert.equal(
    officialSubmitStop({
      label: "Email",
      task: "buy the lamp",
      host: "shop.example",
      fieldEnter: true,
    }),
    undefined,
  );
  assert.equal(
    pageGuard({
      kind: "submit",
      host: "irs.gov",
      label: "Email",
      task: "fill the tax return",
      fieldEnter: true,
    }).stop,
    OFFICIAL_FORM_STOP,
  );
  assert.equal(
    pageGuard({ kind: "submit", host: "irs.gov", label: "File", task: "fill the tax return" }).stop,
    OFFICIAL_FORM_STOP,
  );
});

test("page text for a guard is read in an isolated world, and Enter in a field is a submit", () => {
  const source = readFileSync(new URL("../src/code-api-page.ts", import.meta.url), "utf8");
  assert.match(source, /__isolatedEval\(target, '\(function \(\) \{ var body = document\.body/);
  assert.match(source, /__formField\(step\.element\)/);
  assert.doesNotMatch(
    source,
    /browser\.page\(target\)\.inspect\(function \(\) \{\s*var body = document\.body/,
  );
});

test("an announced irreversible step is named, and a requested one is not", () => {
  assert.match(
    unaskedIrreversible("fill the form, don't submit", "Now I'll submit the application"),
    /did not ask/,
  );
  assert.equal(
    unaskedIrreversible("submit the form", "Now I'll submit the application"),
    undefined,
  );
});
