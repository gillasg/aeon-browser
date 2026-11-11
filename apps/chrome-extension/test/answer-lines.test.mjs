import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function load(entry) {
  const directory = await mkdtemp(fileURLToPath(new URL("./.answer-lines-", import.meta.url)));
  const outfile = join(directory, "bundle.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
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

const speed = {
  chatId: "chat",
  runId: "run",
  items: [
    { kind: "notice", text: "1.1 s · from memory (was 38 s)" },
    { kind: "learned", abilityId: "shop.test/orders", name: "orders", site: "shop.test" },
    { kind: "offer", id: "fresh:shop.test:orders", text: "Do it fresh", action: "fresh" },
    {
      kind: "offer",
      id: "get-all:shop.test:orders",
      text: "Partial: 20 of 143 rows.",
      action: "get-all",
    },
  ],
  wrong: { routeId: "r1" },
};

test("a run card becomes a speed line, a learned line and two offers", async () => {
  const lines = await load("../../../packages/ui/src/answer-lines.ts");
  const footer = lines.footerFromCard(speed);
  assert.deepEqual(
    footer.lines.map((line) => line.text),
    [
      "1.1 s · from memory (was 38 s)",
      "Learned: orders",
      "Do it fresh",
      "Partial: 20 of 143 rows.",
    ],
  );
  assert.equal(footer.lines[2].label, "Do it fresh");
  assert.equal(footer.lines[2].followUp, "Do that again from scratch, without the saved way.");
  assert.equal(footer.lines[3].label, "Get all");
  assert.equal(footer.wrong.routeId, "r1");
});

test("a later learned card keeps the speed line, and internal names are dropped", async () => {
  const lines = await load("../../../packages/ui/src/answer-lines.ts");
  const first = lines.footerFromCard({
    items: [{ kind: "notice", text: "38 s · first time" }],
  });
  const learned = lines.footerFromCard({
    items: [
      { kind: "learned", abilityId: "shop.test/orders", name: "orders", site: "shop.test" },
      { kind: "notice", text: "crawl" },
    ],
  });
  const merged = lines.mergeFooters(first, learned);
  assert.deepEqual(
    merged.lines.map((line) => line.text),
    ["38 s · first time", "Learned: orders"],
  );
  assert.equal(lines.footerFromCard({ items: [{ kind: "notice", text: "site_mapper" }] }), null);
  assert.equal(lines.footerFromCard({ items: [] }), null);
  assert.equal(lines.runCardOf({ kind: "message-end" }), undefined);
  assert.equal(lines.runCardOf({ kind: "run-card", card: speed }), speed);
});

test("offers stop at two", async () => {
  const lines = await load("../../../packages/ui/src/answer-lines.ts");
  const footer = lines.footerFromCard({
    items: [
      { kind: "offer", id: "a", text: "One", action: "watch" },
      { kind: "offer", id: "b", text: "Two", action: "schedule" },
      { kind: "offer", id: "c", text: "Three", action: "pin" },
    ],
  });
  assert.deepEqual(
    footer.lines.map((line) => line.id),
    ["a", "b"],
  );
});

test("the lines render under an answer, with the offer's own words beside its button", async () => {
  const view = await load("../../../packages/ui/src/answer-lines-view.tsx");
  const footer = {
    lines: [
      { kind: "notice", text: "1.1 s · from memory (was 38 s)" },
      { kind: "learned", text: "Learned: orders" },
      {
        kind: "offer",
        id: "get-all",
        text: "Partial: 20 of 143 rows.",
        label: "Get all",
        action: "get-all",
        followUp: "Get all of the rows, not just the part you have.",
      },
    ],
    wrong: { routeId: "r1" },
  };
  let picked = "";
  const html = renderToStaticMarkup(
    createElement(view.AnswerLines, {
      footer,
      onOffer(offer) {
        picked = offer.followUp;
      },
      onWrong() {
        picked = "wrong";
      },
    }),
  );
  assert.match(html, /answer-lines/);
  assert.match(html, /1\.1 s · from memory/);
  assert.match(html, /Learned: orders/);
  assert.match(html, /Partial: 20 of 143 rows\./);
  assert.match(html, />Get all</);
  assert.match(html, />Wrong</);
  assert.equal(picked, "");
});
