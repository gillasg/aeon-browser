import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listRoutes, saveAbility, settleRoutes, stageRun } from "@browserkit/site-mapper";
import { isWordCorrection, RouteRecorder } from "../dist/route-recorder.js";
import { absorb, openRun } from "../dist/route-observe.js";
import { draftPrompt } from "../dist/route-draft.js";
import { rememberDecline } from "../dist/route-memory.js";

test("a steer during a run is a correction and the opening prompt is not", () => {
  const run = openRun("chat", "run", "orders for 2024", "orders for 2024", 1);
  const opened = absorb(run, { kind: "user", text: "orders for 2024" }, 2);
  assert.equal(opened.run.corrected, false);
  const steered = absorb(opened.run, { kind: "user", text: "that was wrong" }, 3);
  assert.equal(steered.run.corrected, true);
});

test("a draft block does not contain the user's message", () => {
  assert.equal(draftPrompt("orders", undefined), "orders");
  const block = draftPrompt("orders for 2025", {
    site: "shop.test",
    summary: "orders",
    cell: "await page.click()",
    ranAt: "2026-11-03",
  });
  assert.match(block, /^\[draft\]\nshop\.test/);
  assert.equal(block.includes("orders for 2025"), false);
});

test("correction words are a skip only for a short follow-up", () => {
  assert.equal(isWordCorrection("orders for 2024", "show the invoice instead"), false);
  assert.equal(isWordCorrection("orders for 2024", "what's wrong with the total"), false);
  assert.equal(isWordCorrection("orders for 2024", "nope"), true);
  assert.equal(isWordCorrection("orders for 2024", "not that"), true);
});

function stepEvent(site, label) {
  return {
    kind: "tool-update",
    toolCallId: "t",
    toolName: "browser_code",
    arguments: {},
    partialResult: "",
    steps: [
      {
        id: "open",
        cellId: "c",
        chatId: "chat",
        tabId: 1,
        at: 1,
        ms: 20,
        kind: "click",
        label,
        site,
        write: false,
        effect: "confirmed",
        target: { role: "link", name: label },
        evidence: {
          navigated: `https://${site}/orders/2024`,
          request: { method: "GET", path: "/orders", status: 200 },
        },
      },
    ],
  };
}

test("a finished run saves a route and the next prompt gets the draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-run-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  const cards = [];
  const recorder = new RouteRecorder({ publish: (_chat, event) => cards.push(event) }, 60_000);
  try {
    const prompt = await recorder.prepare("chat", "orders for 2024");
    assert.equal(prompt.text, "orders for 2024");
    assert.equal(prompt.draft, undefined);
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", stepEvent("shop.test", "Orders 2024"));
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, "run-card");
    assert.match(cards[0].card.items[0].text, /first time/);
    assert.equal((await listRoutes("shop.test")).length, 0);
    await settleRoutes("shop.test", new Date(Date.now() + 4 * 60 * 1000));
    const saved = await listRoutes("shop.test");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].watcher, undefined);
    const again = await recorder.prepare("chat", "orders for 2025");
    assert.equal(again.text, "orders for 2025");
    assert.equal(again.draft.site, "shop.test");
    assert.match(again.draft.cell, /await page\.click/);
    assert.equal(again.draft.cell.includes("orders for 2025"), false);
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", stepEvent("shop.test", "Orders 2025"));
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    assert.match(cards.at(-1).card.items[0].text, /with a saved draft/);
    assert.equal(cards.at(-1).card.items[0].text.includes("from memory"), false);
    recorder.noteWatcher("routine", "watch the orders");
    await recorder.observe("routine", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("routine", stepEvent("watch.test", "Watch"));
    await recorder.observe("routine", { kind: "run-state", state: "idle" });
    await settleRoutes("watch.test", new Date(Date.now() + 4 * 60 * 1000));
    const watched = await listRoutes("watch.test");
    assert.equal(watched.length, 1);
    assert.equal(watched[0].watcher, true);
  } finally {
    recorder.close();
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a new task that says instead or wrong does not block the route", async () => {
  await withRecorder(async (recorder) => {
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    await recorder.prepare("chat", "show the invoice instead");
    await recorder.prepare("chat", "what's wrong with the total");
    await settleRoutes("shop.test", new Date(Date.now() + 4 * 60 * 1000));
    assert.equal((await listRoutes("shop.test")).length, 1);
    const later = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: [recordedStep("shop.test", "Orders")],
    });
    assert.equal(later.status, "pending");
  });
});

test("a short follow-up skips that run and a later one can still be saved", async () => {
  await withRecorder(async (recorder) => {
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    const skip = await recorder.prepare("chat", "nope");
    assert.equal(skip.text, "nope");
    await settleRoutes("shop.test", new Date(Date.now() + 4 * 60 * 1000));
    assert.equal((await listRoutes("shop.test")).length, 0);
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    await settleRoutes("shop.test", new Date(Date.now() + 4 * 60 * 1000));
    assert.equal((await listRoutes("shop.test")).length, 1);
    const later = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: [recordedStep("shop.test", "Orders")],
    });
    assert.notEqual(later.status, "blocked");
  });
});

async function withRecorder(run) {
  const root = await mkdtemp(join(tmpdir(), "route-run-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  const cards = [];
  const recorder = new RouteRecorder({ publish: (_chat, event) => cards.push(event) }, 60_000);
  try {
    await run(recorder, cards);
  } finally {
    recorder.close();
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("a short clean run offers nothing to save", async () => {
  await withRecorder(async (recorder, cards) => {
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    assert.equal(saveOffers(cards.at(-1)).length, 0);
  });
});

test("a run that failed then worked offers to save the ability once", async () => {
  await withRecorder(async (recorder, cards) => {
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", {
      kind: "tool-end",
      toolCallId: "t1",
      toolName: "browser_code",
      result: "TIMEOUT: the click did not land",
      isError: true,
    });
    await recorder.observe("chat", stepEvent("shop.test", "Orders"));
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    const offers = saveOffers(cards.at(-1));
    assert.equal(offers.length, 1);
    assert.match(offers[0].text, /save this as an ability/i);
  });
});

test("a mid-run correction offers to save the corrected run once", async () => {
  await withRecorder(async (recorder, cards) => {
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", stepEvent("shop.test", "Orders"));
    await recorder.observe("chat", {
      kind: "message-end",
      message: { role: "user", content: [{ type: "text", text: "not that, the open orders" }] },
    });
    await recorder.observe("chat", stepEvent("shop.test", "Open orders"));
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    assert.equal(saveOffers(cards.at(-1)).length, 1);
  });
});

test("a correction in the next message makes that run worth saving", async () => {
  await withRecorder(async (recorder, cards) => {
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    await finishRun(recorder, "chat", "nope", "shop.test");
    assert.equal(saveOffers(cards.at(-1)).length, 1);
  });
});

test("a save offer after a correction is keyed to the task, so a decline sticks", async () => {
  await withRecorder(async (recorder, cards) => {
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    await finishRun(recorder, "chat", "nope", "shop.test");
    const offers = saveOffers(cards.at(-1));
    assert.equal(offers.length, 1);
    assert.equal(offers[0].id, "save-ability:shop.test:2024 orders");

    await rememberDecline("shop.test", offers[0].id);
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", {
      kind: "tool-end",
      toolCallId: "t1",
      toolName: "browser_code",
      result: "TIMEOUT: the click did not land",
      isError: true,
    });
    await recorder.observe("chat", stepEvent("shop.test", "Orders"));
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    assert.equal(saveOffers(cards.at(-1)).length, 0, "the declined task stays declined");
  });
});

test("a correction still finds an ability that covers the task it corrects", async () => {
  await withRecorder(async (recorder, cards) => {
    await saveAbility(ability("orders"));
    await finishRun(recorder, "chat", "orders for 2024", "shop.test");
    await finishRun(recorder, "chat", "nope", "shop.test");
    assert.equal(saveOffers(cards.at(-1)).length, 0);
  });
});

test("an ability that already covers the task gets no save offer", async () => {
  await withRecorder(async (recorder, cards) => {
    await saveAbility(ability("orders"));
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", stepEvent("shop.test", "Orders"));
    await recorder.observe("chat", {
      kind: "message-end",
      message: { role: "user", content: [{ type: "text", text: "that was wrong" }] },
    });
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    assert.equal(saveOffers(cards.at(-1)).length, 0);
  });
});

test("a failed and corrected run still offers one save offer, not two", async () => {
  await withRecorder(async (recorder, cards) => {
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", {
      kind: "tool-end",
      toolCallId: "t1",
      toolName: "browser_code",
      result: "TIMEOUT: the click did not land",
      isError: true,
    });
    await recorder.observe("chat", {
      kind: "message-end",
      message: { role: "user", content: [{ type: "text", text: "that was wrong" }] },
    });
    await recorder.observe("chat", stepEvent("shop.test", "Orders"));
    await recorder.observe("chat", { kind: "run-state", state: "idle" });
    assert.equal(saveOffers(cards.at(-1)).length, 1);
    assert.equal(cards.filter((card) => saveOffers(card).length).length, 1);
  });
});

test("an unsure finish is not a success worth saving", async () => {
  await withRecorder(async (recorder, cards) => {
    await recorder.prepare("chat", "orders for 2024");
    await recorder.observe("chat", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("chat", stepEvent("shop.test", "Orders"));
    await recorder.observe("chat", { kind: "run-state", state: "uncertain" });
    assert.equal(saveOffers(cards.at(-1)).length, 0);
  });
});

function saveOffers(card) {
  return (card?.card.items ?? []).filter(
    (item) => item.kind === "offer" && item.action === "save-ability",
  );
}

function ability(name) {
  return {
    name,
    site: "shop.test",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function finishRun(recorder, chatId, prompt, site) {
  await recorder.prepare(chatId, prompt);
  await recorder.observe(chatId, { kind: "run-state", state: "running-unconfirmed" });
  await recorder.observe(chatId, stepEvent(site, "Orders"));
  await recorder.observe(chatId, { kind: "run-state", state: "idle" });
}

function recordedStep(site, label) {
  return {
    id: "open",
    kind: "click",
    target: { role: "link", name: label },
    effect: "confirmed",
    write: false,
    pageType: "orders",
    url: `https://${site}/orders/2024`,
    evidence: {
      navigated: `https://${site}/orders/2024`,
      request: { method: "GET", path: "/orders", status: 200 },
    },
  };
}
