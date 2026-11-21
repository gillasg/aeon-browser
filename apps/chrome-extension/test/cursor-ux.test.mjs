import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// One bundle of the cursor's pure parts: target rules, in-place answers, view rows, Manage tab
// reuse, site facts and offer actions. @aeon/ui is the real package.
async function load() {
  const directory = await mkdtemp(fileURLToPath(new URL("./.cursor-ux-", import.meta.url)));
  const entry = join(directory, "entry.ts");
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  await writeFile(
    entry,
    [
      `export * from ${JSON.stringify(src + "orb/orb-target-rules.ts")};`,
      `export * from ${JSON.stringify(src + "orb/orb-answer.tsx")};`,
      `export * from ${JSON.stringify(src + "orb/orb-view-parts.tsx")};`,
      `export * from ${JSON.stringify(src + "manage-tab.ts")};`,
      `export { boostToTurnOff, enabledBoostCount } from ${JSON.stringify(src + "site-facts.ts")};`,
      `export { mcpSnippet } from ${JSON.stringify(src + "offer-actions.ts")};`,
      "",
    ].join("\n"),
  );
  const outfile = join(directory, "bundle.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"],
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const ux = await load();
const viewport = { width: 1000, height: 800 };

function node(
  tagName,
  { attrs = {}, text = "", box = { width: 100, height: 20 }, parent = null } = {},
) {
  const element = {
    tagName,
    parentElement: parent,
    childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => name in attrs,
    getBoundingClientRect: () => box,
  };
  return element;
}

test("a selection of two or more characters wins, in curly quotes, cut at 28", () => {
  assert.equal(ux.selectionLabel(" a "), undefined);
  assert.deepEqual(ux.selectionLabel("₹49,999"), { label: "“₹49,999”", title: "₹49,999" });
  const long = ux.selectionLabel("a".repeat(40));
  assert.equal(long.label.length, 28);
  assert.ok(long.label.endsWith("…”"));
});

test("labels collapse whitespace and cut at 28 characters with an ellipsis", () => {
  assert.equal(ux.truncateLabel("  Add   to   cart "), "Add to cart");
  const cut = ux.truncateLabel("x".repeat(30));
  assert.equal(cut.length, 28);
  assert.ok(cut.endsWith("…"));
});

test("interactive and content elements are accepted; page structure is not", () => {
  const body = node("BODY", { box: { width: 1000, height: 800 } });
  const section = node("SECTION", { parent: body });
  const button = node("BUTTON", { text: "Buy now", parent: section });
  assert.equal(ux.pickTarget([button], viewport), button);
  assert.equal(ux.pickTarget([section, body], viewport), undefined);
  const heading = node("H2", { text: "Deals", parent: body });
  assert.equal(ux.pickTarget([heading], viewport), heading);
});

test("plain wrappers, huge, tiny, iframes and Aeon's overlay are rejected", () => {
  const div = node("DIV");
  assert.equal(ux.acceptable(div, viewport), false);
  assert.equal(ux.acceptable(node("DIV", { attrs: { role: "button" } }), viewport), true);
  assert.equal(ux.acceptable(node("LI", { box: { width: 900, height: 700 } }), viewport), false);
  assert.equal(ux.acceptable(node("BUTTON", { box: { width: 3, height: 10 } }), viewport), false);
  assert.equal(ux.acceptable(node("IFRAME"), viewport), false);
  const overlay = node("BUTTON", { attrs: { "data-aeon-overlay": "" }, text: "Stop" });
  const under = node("A", { attrs: { href: "/x" }, text: "Deal" });
  assert.equal(ux.pickTarget([overlay, under], viewport), under);
});

test("the pick climbs at most three ancestors", () => {
  const link = node("A", { attrs: { href: "/p" } });
  const a = node("SPAN", { parent: link });
  const b = node("SPAN", { parent: a });
  const c = node("SPAN", { parent: b });
  assert.equal(ux.pickTarget([c], viewport), link);
  const d = node("SPAN", { parent: c });
  assert.equal(ux.pickTarget([d], viewport), undefined);
});

test("element labels: aria-label, alt, own text, placeholder, then the field", () => {
  assert.equal(
    ux.elementLabel(node("BUTTON", { attrs: { "aria-label": "Close" }, text: "×" })),
    "Close",
  );
  assert.equal(ux.elementLabel(node("IMG", { attrs: { alt: "Red shoe" } })), "Red shoe");
  assert.equal(ux.elementLabel(node("INPUT", { attrs: { placeholder: "Pincode" } })), "Pincode");
  assert.equal(ux.elementLabel(node("INPUT", { attrs: { type: "search" } })), "Search field");
});

test("the payload has a selector, label, role, tag and at most 200 characters of text", () => {
  const payload = ux.targetPayload(node("BUTTON", { text: "y".repeat(300) }), "#buy");
  assert.equal(payload.selector, "#buy");
  assert.equal(payload.role, "button");
  assert.equal(payload.tag, "button");
  assert.equal(payload.text.length, 200);
  assert.equal("outerHTML" in payload, false);
});

test("Fill form needs one form with three visible, enabled fields", () => {
  const field = (tagName, type, extra = {}) => ({
    tagName,
    type,
    disabled: false,
    offsetParent: {},
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    ...extra,
  });
  const ok = [field("INPUT", "text"), field("INPUT", "email"), field("SELECT")];
  assert.equal(ux.hasFillableForm([{ fields: ok }]), true);
  const weak = [
    field("INPUT", "text"),
    field("INPUT", "hidden"),
    field("INPUT", "submit"),
    field("INPUT", "search"),
    field("TEXTAREA", undefined, { disabled: true }),
    field("INPUT", "text", { offsetParent: null }),
    field("INPUT", "text", { getBoundingClientRect: () => ({ width: 2, height: 2 }) }),
  ];
  assert.equal(ux.hasFillableForm([{ fields: weak }]), false);
});

test("short answers and small tables show in place; long, headed or coded ones do not", () => {
  assert.equal(ux.answerFits("The cheapest is **₹49,999** at [Shop](https://shop.test)."), true);
  assert.equal(ux.answerFits("x ".repeat(200)), false);
  assert.equal(ux.answerFits("# Title\nbody"), false);
  assert.equal(ux.answerFits("```js\ncode\n```"), false);
  const table = "| Item | Price |\n|---|---|\n| A | 10 |\n| B | 20 |\nTwo found.";
  assert.equal(ux.answerFits(table), true);
  const wide = "| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |";
  assert.equal(ux.answerFits(wide), false);
  const html = renderToStaticMarkup(createElement(ux.AnswerInPlace, { text: table }));
  assert.match(html, /<table class="isl-table">/);
  assert.match(html, /data-numeric="true">10</);
});

test("the X-Ray strip says counts with exact plurals and is absent at zero", () => {
  const strip = (counts) =>
    renderToStaticMarkup(createElement(ux.XrayStrip, { host: "shop.com", counts, onOpen() {} }));
  assert.equal(strip({ apis: 0, boosts: 0, watches: 0 }), "");
  const html = strip({ apis: 4, boosts: 1, watches: 0 });
  assert.match(html, /aria-label="What Aeon knows about shop.com"/);
  assert.equal(html.replace(/<[^>]+>/g, ""), "4 APIs · 1 boost");
});

test("the power row is three prefills at most, Fill form only with a form", () => {
  assert.deepEqual(
    ux.powerItems(false).map((item) => item.label),
    ["Boost this site", "Watch"],
  );
  assert.deepEqual(
    ux.powerItems(true).map((item) => item.prefill),
    ["Change this site so that ", "Tell me when ", "Fill this form from my details"],
  );
});

test("Teach says what it found, singular for one", () => {
  assert.equal(ux.teachingLabel(0), "Teaching");
  assert.equal(ux.teachingLabel(1), "Teaching · 1 API");
  assert.equal(ux.teachingLabel(3), "Teaching · 3 APIs");
  assert.equal(ux.learnedLine(4, "flipkart.com"), "Learned 4 APIs on flipkart.com");
  const idle = renderToStaticMarkup(
    createElement(ux.TeachControl, { learning: false, found: 0, onToggle() {} }),
  );
  assert.match(idle, />Teach</);
  assert.match(idle, /debugger bar/);
  const on = renderToStaticMarkup(
    createElement(ux.TeachControl, { learning: true, found: 2, onToggle() {} }),
  );
  assert.match(on, /isl-rec/);
  assert.match(on, />Done</);
  assert.doesNotMatch(on, /debugger bar/);
});

test("Manage reuses an open home.html tab, never the side panel's", () => {
  const base = "chrome-extension://id/home.html";
  const tabs = [
    { id: 1, url: base + "?host=panel", lastAccessed: 9 },
    { id: 2, url: base, lastAccessed: 3 },
    { id: 3, url: base + "?view=sites", lastAccessed: 5 },
    { id: 4, url: "https://shop.com/", lastAccessed: 10 },
  ];
  assert.equal(ux.pickManageTab(tabs, base).id, 3);
  assert.equal(ux.pickManageTab([tabs[0]], base), undefined);
  assert.equal(ux.manageSitesRoute("flipkart.com"), "#sites?host=flipkart.com");
  assert.equal(ux.manageRoute("#sites?host=flipkart.com"), "#sites?host=flipkart.com");
  assert.equal(ux.manageRoute("javascript:alert(1)"), "");
});

test("boost helpers count only enabled boosts and pick the latest change", () => {
  const rows = [
    { id: "a", enabled: true, updated: 1 },
    { id: "b", enabled: false, updated: 9 },
    { id: "c", enabled: true, updated: 5 },
  ];
  assert.equal(ux.enabledBoostCount(rows), 2);
  assert.equal(ux.boostToTurnOff(rows).id, "c");
});

test("Copy MCP copies a server entry for the site", () => {
  assert.deepEqual(JSON.parse(ux.mcpSnippet("shop.com")), {
    mcpServers: { "shop.com": { command: "aeon", args: ["mcp", "shop.com"] } },
  });
});
