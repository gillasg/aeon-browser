import assert from "node:assert/strict";
import test from "node:test";
import { buildRunCard, receiptFor } from "../dist/run-card.js";
import { boostEffect, deterministicWatchCall } from "../dist/run-effects.js";
import { siteCountKey, siteCounts } from "../dist/site-counts.js";
import { RunCardSchema } from "@graft/protocol";

const base = { chatId: "chat", runId: "run", site: "shop.test", task: "orders" };

test("no proof facts, no receipt", () => {
  assert.equal(receiptFor({ ...base, durationMs: 800 }), undefined);
});

test("receipts follow vault > repaired > speed > boost > watch", () => {
  const all = {
    vault: true,
    repairedVersion: 2,
    modelFree: true,
    boost: { edit: false },
    deterministicWatch: true,
  };
  assert.equal(receiptFor({ ...base, durationMs: 800, proof: all }).receipt, "vault");
  const noVault = { ...all, vault: false };
  assert.deepEqual(receiptFor({ ...base, durationMs: 800, proof: noVault }), {
    kind: "receipt",
    receipt: "repaired",
    version: 2,
  });
  const speed = { ...noVault, repairedVersion: undefined };
  assert.equal(receiptFor({ ...base, durationMs: 800, proof: speed }).receipt, "speed");
  const boost = { ...speed, modelFree: false };
  assert.equal(receiptFor({ ...base, proof: boost }).receipt, "boost");
  assert.equal(receiptFor({ ...base, proof: { deterministicWatch: true } }).receipt, "watch");
});

test("a speed receipt carries a previous run only when one was measured, and no cost unless computed", () => {
  const card = buildRunCard({
    ...base,
    durationMs: 800,
    path: "saved ability",
    proof: { modelFree: true },
  });
  const receipt = card.items.find((item) => item.kind === "receipt");
  assert.deepEqual(receipt, { kind: "receipt", receipt: "speed", durationMs: 800 });
  assert.equal(
    card.items.filter((item) => item.kind === "notice").length,
    0,
    "no second speed line",
  );
  assert.deepEqual(
    card.items.filter((item) => item.kind === "offer").map((item) => item.action),
    ["copy-mcp"],
  );
  const measured = receiptFor({
    ...base,
    durationMs: 800,
    previousMs: 34000,
    proof: { modelFree: true },
  });
  assert.equal(measured.previousMs, 34000);
  assert.equal(measured.costUsd, undefined);
  assert.ok(RunCardSchema.safeParse(card).success);
});

test("a new boost offers Undo, an edited one Turn off, with its id and page", () => {
  const made = buildRunCard({
    ...base,
    proof: { boost: { edit: false, boostId: "b1", url: "https://shop.test/" } },
  });
  const offer = made.items.find((item) => item.kind === "offer");
  assert.equal(offer.action, "undo-boost");
  assert.deepEqual(offer.args, { boostId: "b1", url: "https://shop.test/" });
  const edited = buildRunCard({ ...base, proof: { boost: { edit: true } } });
  assert.equal(edited.items.find((item) => item.kind === "offer").action, "toggle-boost");
  assert.ok(RunCardSchema.safeParse(made).success);
});

test("offers stay capped at two with the receipt's button first", () => {
  const card = buildRunCard({
    ...base,
    fromMemory: true,
    saveAbility: true,
    proof: { boost: { edit: false } },
  });
  const offers = card.items.filter((item) => item.kind === "offer").map((item) => item.action);
  assert.deepEqual(offers, ["undo-boost", "fresh"]);
});

test("a page-only run on a site with saved ways offers Run via API", () => {
  const card = buildRunCard({ ...base, proof: { apiAvailable: true } });
  assert.equal(card.items.find((item) => item.kind === "offer").action, "run-api");
});

test("boost effects come from successful boosts.save cells only", () => {
  assert.equal(
    boostEffect([{ code: "await browser.boosts.save({css: 'a{}'})", ok: false }]),
    undefined,
  );
  assert.deepEqual(
    boostEffect([
      {
        code: "await browser.boosts.save({ name: 'x', css: 'a{}' })",
        ok: true,
        result: '{"id":"boost-123","name":"x"}',
      },
    ]),
    { edit: false, boostId: "boost-123" },
  );
  assert.deepEqual(
    boostEffect([{ code: "browser.boosts.save({ id: 'b9', css: '' })", ok: true }]),
    {
      edit: true,
    },
  );
});

test("only a create_routine with a check is a no-model watch", () => {
  assert.equal(
    deterministicWatchCall("create_routine", { check: "price < 4 ? {price} : false" }),
    true,
  );
  assert.equal(deterministicWatchCall("create_routine", { instruction: "check it" }), false);
  assert.equal(deterministicWatchCall("browser_code", { check: "x" }), false);
});

test("site counts key loopback by port and leave other ports out", () => {
  assert.equal(siteCountKey("www.Shop.com"), "shop.com");
  assert.equal(siteCountKey("127.0.0.1:8080"), "127.0.0.1:8080");
  assert.equal(siteCountKey("https://shop.com:443/x"), "shop.com");
  const rows = siteCounts(
    [
      { site: "shop.com", operations: 4 },
      { site: "127.0.0.1:3000", operations: 2 },
      { site: "empty.com", operations: 0 },
    ],
    [
      { enabled: true, deletedAt: null, sites: ["shop.com"], listen: null },
      { enabled: false, deletedAt: null, sites: ["shop.com"], listen: null },
      { enabled: true, deletedAt: "2026-01-01", sites: ["shop.com"], listen: null },
      { enabled: true, deletedAt: null, sites: [], listen: { url: "http://127.0.0.1:3000/api" } },
    ],
  );
  assert.deepEqual(rows, [
    { site: "shop.com", apis: 4, watches: 1 },
    { site: "127.0.0.1:3000", apis: 2, watches: 1 },
  ]);
});

import { RouteRecorder } from "../dist/route-recorder.js";
import { parseWebhook } from "../dist/routine-fields.js";
import { authorizeNativeUiScope } from "../dist/native-ui-authz.js";
import { namedHosts } from "../dist/browser-site-rules.js";

async function runToolReceiptCase(recorder, chatId, prompt, toolEvent, assistantText) {
  await recorder.prepare(chatId, prompt);
  await recorder.observe(chatId, { kind: "run-state", state: "running-unconfirmed" });
  await recorder.observe(chatId, toolEvent);
  if (assistantText) {
    await recorder.observe(chatId, {
      kind: "message-end",
      message: {
        id: `m-${chatId}`,
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: assistantText }],
      },
    });
  }
  await recorder.observe(chatId, { kind: "run-state", state: "idle" });
}

test("RouteRecorder emits vault, repaired, and zero-step watch receipts honestly", async () => {
  const cards = [];
  const recorder = new RouteRecorder({
    publish: (_chatId, event) => {
      if (event.kind === "run-card") cards.push(event.card);
    },
  });
  try {
    await runToolReceiptCase(
      recorder,
      "c1",
      "sign in to shop.test",
      {
        kind: "tool-end",
        toolCallId: "t1",
        toolName: "browser_code",
        result: "signed in",
        isError: false,
        proof: { vault: true, site: "shop.test" },
      },
      "Signed in.",
    );
    assert.deepEqual(
      cards[0].items.find((i) => i.kind === "receipt"),
      { kind: "receipt", receipt: "vault" },
    );

    await runToolReceiptCase(
      recorder,
      "c2",
      "check orders on shop.test",
      {
        kind: "tool-end",
        toolCallId: "t2",
        toolName: "site_mapper",
        result: "orders",
        isError: false,
        proof: {
          usedAbility: true,
          usedApi: true,
          compiled: true,
          repairedVersion: 3,
          site: "shop.test",
        },
      },
      "Here are your orders.",
    );
    assert.deepEqual(
      cards[1].items.find((i) => i.kind === "receipt"),
      { kind: "receipt", receipt: "repaired", version: 3 },
    );
    assert.ok(cards[1].items.some((i) => i.kind === "offer" && i.action === "copy-mcp"));

    await recorder.prepare("c3", "watch price on shop.test");
    await recorder.observe("c3", { kind: "run-state", state: "running-unconfirmed" });
    await recorder.observe("c3", {
      kind: "tool-start",
      toolCallId: "t3",
      toolName: "create_routine",
      arguments: { check: "price < 50", sites: ["shop.test"] },
    });
    await recorder.observe("c3", {
      kind: "tool-end",
      toolCallId: "t3",
      toolName: "create_routine",
      result: "created",
      isError: false,
    });
    await recorder.observe("c3", { kind: "run-state", state: "idle" });
    assert.deepEqual(
      cards[2].items.find((i) => i.kind === "receipt"),
      { kind: "receipt", receipt: "watch" },
    );
  } finally {
    recorder.close();
  }
});

test("RouteRecorder gates speed receipt on zero model turns while keeping Copy MCP", async () => {
  const cards = [];
  const recorder = new RouteRecorder({
    publish: (_chatId, event) => {
      if (event.kind === "run-card") cards.push(event.card);
    },
  });
  try {
    await runToolReceiptCase(recorder, "c4", "orders on shop.test", {
      kind: "tool-end",
      toolCallId: "t4",
      toolName: "site_mapper",
      result: "ok",
      isError: false,
      proof: { usedApi: true, site: "shop.test" },
    });
    assert.equal(cards[0].items.find((i) => i.kind === "receipt")?.receipt, "speed");

    await runToolReceiptCase(
      recorder,
      "c5",
      "orders on shop.test",
      {
        kind: "tool-end",
        toolCallId: "t5",
        toolName: "site_mapper",
        result: "ok",
        isError: false,
        proof: { usedApi: true, site: "shop.test" },
      },
      "Done.",
    );
    assert.equal(
      cards[1].items.find((i) => i.kind === "receipt"),
      undefined,
    );
    assert.ok(cards[1].items.some((i) => i.kind === "offer" && i.action === "copy-mcp"));
  } finally {
    recorder.close();
  }
});

test("security guards block SSRF webhooks, overbroad chat management actions, and email hosts", () => {
  assert.throws(() => parseWebhook("http://127.0.0.1:8080/hook", undefined, null), /public host/i);
  assert.throws(
    () => parseWebhook("http://169.254.169.254/latest/meta-data", undefined, null),
    /public host/i,
  );
  assert.throws(() => parseWebhook("http://localhost:3000/hook", undefined, null), /public host/i);
  assert.throws(() => parseWebhook("http://192.168.1.10/hook", undefined, null), /public host/i);
  assert.throws(() => parseWebhook("http://[::1]/hook", undefined, null), /public host/i);
  assert.equal(
    parseWebhook("https://hooks.example.com/graft", undefined, null)?.url,
    "https://hooks.example.com/graft",
  );

  const chatGrant = { role: "ui", scope: { kind: "chat", chatId: "chat-1" } };
  assert.equal(
    authorizeNativeUiScope(chatGrant, {
      kind: "command",
      requestId: "r1",
      operation: "management.action",
      payload: { chatId: "chat-1", action: "export_site", input: { site: "x.com" } },
    }),
    false,
  );
  assert.equal(
    authorizeNativeUiScope(chatGrant, {
      kind: "command",
      requestId: "r2",
      operation: "management.action",
      payload: { chatId: "chat-1", action: "create_routine", input: {} },
    }),
    true,
  );

  assert.deepEqual(namedHosts("Email me at alice@chase.com about example.com"), ["example.com"]);
});
