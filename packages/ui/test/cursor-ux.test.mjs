import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { footerFromCard, watchBelowLabel } from "../dist/answer-lines.js";
import { AnswerLines } from "../dist/answer-lines-view.js";
import { formatReceipt } from "../dist/answer-receipt.js";
import { normalizeSite, siteKey, xrayText } from "../dist/site-xray.js";
import { parseHashRoute } from "../dist/manage-route.js";
import { MANAGE_NAV } from "../dist/manage-nav.js";
import { NewUserWelcome, WELCOME_EXAMPLES, resetWelcome } from "../dist/new-user-welcome.js";
import { SidePanel } from "../dist/side-panel.js";

const card = (items) => ({ chatId: "c", runId: "r", items, wrong: {} });

test("receipt copy is exact, with no emoji", () => {
  assert.equal(
    formatReceipt({ receipt: "vault" }).text,
    "Filled from My Details · the model never saw it",
  );
  assert.equal(formatReceipt({ receipt: "repaired", version: 2 }).text, "Fixed itself · now v2");
  assert.equal(formatReceipt({ receipt: "repaired" }).text, "Fixed itself");
  assert.equal(
    formatReceipt({ receipt: "speed", durationMs: 800, previousMs: 34000 }).text,
    "0.8 s via skill · no model · was 34 s",
  );
  assert.equal(
    formatReceipt({ receipt: "speed", durationMs: 800 }).text,
    "0.8 s via skill · no model",
  );
  assert.equal(
    formatReceipt({ receipt: "speed", durationMs: 800, costUsd: 0 }).text,
    "0.8 s via skill · $0.00",
  );
  assert.equal(formatReceipt({ receipt: "speed" }), null, "no duration, no speed line");
  assert.equal(formatReceipt({ receipt: "boost" }).text, "Boost on");
  assert.equal(formatReceipt({ receipt: "watch" }).text, "Watching · no model per check");
  for (const kind of ["vault", "repaired", "boost", "watch"])
    assert.ok(formatReceipt({ receipt: kind }).short.length <= 24);
  assert.equal(formatReceipt({ receipt: "speed", durationMs: 800 }).short, "0.8 s · via skill");
  assert.equal(formatReceipt({ receipt: "confetti" }), null);
});

test("one receipt per run, by priority, before the other lines", () => {
  const footer = footerFromCard(
    card([
      { kind: "notice", text: "1.1 s · saved ability" },
      { kind: "receipt", receipt: "watch" },
      { kind: "receipt", receipt: "boost" },
      { kind: "receipt", receipt: "repaired", version: 3 },
    ]),
  );
  const receipts = footer.lines.filter((line) => line.kind === "receipt");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt, "repaired");
  assert.equal(footer.lines[0].kind, "receipt");
  const html = renderToStaticMarkup(createElement(AnswerLines, { footer }));
  assert.match(html, /<span class="answer-receipt-lead">Fixed itself<\/span>/);
  assert.doesNotMatch(html, /font-family|monospace/);
});

test("new offer kinds have their labels, and watch-below needs a real number", () => {
  const footer = footerFromCard(
    card([
      { kind: "offer", id: "1", text: "Copy MCP", action: "copy-mcp", args: { site: "shop.com" } },
      { kind: "offer", id: "2", text: "Boost on", action: "undo-boost" },
      { kind: "offer", id: "3", text: "Turn off", action: "toggle-boost" },
    ]),
  );
  assert.deepEqual(
    footer.lines.map((line) => line.label),
    ["Copy MCP"],
    "capped at one",
  );
  assert.deepEqual(footer.lines[0].args, { site: "shop.com" });
  assert.equal(watchBelowLabel({ price: 49999, currency: "₹" }), "Watch under ₹49999");
  assert.equal(watchBelowLabel({}), "");
  assert.equal(watchBelowLabel({ price: 123456789, currency: "USD" }), "", "over 18 characters");
  const none = footerFromCard(
    card([{ kind: "offer", id: "4", text: "Watch", action: "watch-below" }]),
  );
  assert.equal(none, null);
  const run = footerFromCard(card([{ kind: "offer", id: "5", text: "Run", action: "run-api" }]));
  assert.equal(run.lines[0].label, "Run via API");
});

test("X-Ray text: exact plurals, zero counts left out", () => {
  assert.equal(xrayText({ apis: 4, boosts: 1, watches: 1 }), "4 APIs · 1 boost · 1 watch");
  assert.equal(xrayText({ apis: 1, boosts: 2, watches: 3 }), "1 API · 2 boosts · 3 watches");
  assert.equal(xrayText({ apis: 0, boosts: 0, watches: 2 }), "2 watches");
  assert.equal(xrayText({ apis: 0, boosts: 0, watches: 0 }), "");
});

test("site keys are host:port only on loopback", () => {
  assert.equal(siteKey("https://www.flipkart.com/p/1"), "flipkart.com");
  assert.equal(siteKey("http://127.0.0.1:8080/"), "127.0.0.1:8080");
  assert.equal(siteKey("http://localhost:3000/"), "localhost:3000");
  assert.equal(siteKey("https://shop.com:8443/"), "shop.com");
  assert.equal(siteKey("chrome://settings"), "");
  assert.equal(normalizeSite("www.Flipkart.com"), "flipkart.com");
});

test("Manage hash routes and nav order", () => {
  assert.deepEqual(parseHashRoute("#sites?host=flipkart.com"), {
    page: "sites",
    host: "flipkart.com",
  });
  assert.deepEqual(parseHashRoute(""), { page: "", host: "" });
  assert.deepEqual(
    MANAGE_NAV.map((item) => item.label),
    ["Automations", "Sites", "My Details", "Sign-in", "Settings", "Advanced"],
  );
});

test("the welcome has three quiet examples and the Learn link", () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  resetWelcome();
  assert.deepEqual(
    [...WELCOME_EXAMPLES],
    [
      "Tell me when the price on this page drops",
      "Fill this form with my details",
      "Hide the parts of this site I never use",
    ],
  );
  const html = renderToStaticMarkup(
    createElement(NewUserWelcome, { needsModel: false, onExample() {}, onLearn() {} }),
  );
  assert.match(html, /What can Graft do\?/);
});

test("the side panel header is the switcher and New chat; Manage ends the switcher menu", () => {
  const props = {
    chats: [],
    selectedChatId: "",
    status: "",
    pickerOpen: false,
    chatFrameSrc: "home.html?host=panel",
    onTogglePicker() {},
    onSelect() {},
    onNew() {},
    onManage() {},
  };
  const html = renderToStaticMarkup(createElement(SidePanel, props));
  assert.match(html, /id="selected-chat-title">Graft</);
  assert.match(html, /id="panel-new-chat"/);
  assert.doesNotMatch(html, /open-full|panel-manage|panel-xray|Open in a tab/);
  const chats = [{ chatId: "c1", title: "New Chat", updatedAt: new Date().toISOString() }];
  const idle = renderToStaticMarkup(createElement(SidePanel, { ...props, chats }));
  assert.match(idle, /id="selected-chat-title">New chat</);
  const chosen = renderToStaticMarkup(
    createElement(SidePanel, { ...props, chats, selectedChatId: "c1", pickerOpen: true }),
  );
  assert.match(chosen, /id="selected-chat-title">New chat</);
  assert.match(chosen, /Manage Graft/);
});
