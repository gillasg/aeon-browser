import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function view() {
  // The bundle stays in the package so its external react resolves to this app's copy.
  const directory = await mkdtemp(fileURLToPath(new URL("./.orb-line-", import.meta.url)));
  const stub = join(directory, "ui.mjs");
  await writeFile(stub, "export function ChatSwitcher() { return null; }\n");
  const outfile = join(directory, "view.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/orb/orb-view.tsx", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"],
    alias: { "@aeon/ui": stub },
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const model = {
  host: "x.com",
  chatId: "c1",
  notice: "",
  ask: "",
  busy: false,
  learning: false,
  chats: [],
  context: [],
  tabChoices: null,
  running: new Set(),
  needs: new Set(),
};
const actions = {
  submit() {},
  minimize() {},
  selectChat() {},
  newChat() {},
  loadChats() {},
  toSidePanel() {},
  toggleLearning() {},
  removeContext() {},
  pickTabs() {},
  addContext() {},
};

test("a running line sits above the field without a side-panel link", async () => {
  const orb = await view();
  const html = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: { ...model, line: { text: "Reading your orders · 23 found", more: false } },
      actions,
    }),
  );
  assert.match(html, /isl-line/);
  assert.match(html, /Reading your orders/);
  assert.match(html, /data-clamp="1"/);
  assert.doesNotMatch(html, /isl-line-more/);
  assert.match(html, /<textarea/);
});

test("a finished line clamps to two lines and links to the side panel", async () => {
  const orb = await view();
  const html = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: { ...model, line: { title: "Aeon broke", text: "No model", more: true } },
      actions,
    }),
  );
  assert.match(html, /Aeon broke/);
  assert.match(html, /No model/);
  assert.match(html, /data-clamp="2"/);
  assert.match(html, /isl-line-more/);
  assert.match(html, /Side panel/);
});
