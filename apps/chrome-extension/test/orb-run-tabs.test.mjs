// The cursor box's finish state for "open it for me": the tabs a run kept in the background are
// listed without activating anything, and one click switches to a tab and focuses its window.
// Escape and a click outside tuck the box away; the working line is one calm timed phrase.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const src = fileURLToPath(new URL("../src/", import.meta.url));

async function load(t) {
  const directory = await mkdtemp(fileURLToPath(new URL("./.orb-run-tabs-", import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stub = join(directory, "tab-cleanup.ts");
  await writeFile(
    stub,
    "export const ensureAgentTabsRestored = async () => {};\nexport const mineTabIds = (chatId) => globalThis.__mine[chatId] ?? [];\n",
  );
  const entry = join(directory, "entry.ts");
  await writeFile(
    entry,
    [
      `export * from ${JSON.stringify(src + "orb/orb-run-tabs.ts")};`,
      `export { RunTabPills, WorkingPill, workingLine } from ${JSON.stringify(src + "orb/orb-view-parts.tsx")};`,
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
    plugins: [
      {
        name: "stub-tab-cleanup",
        setup(b) {
          b.onResolve({ filter: /native-browser-tab-cleanup$/ }, () => ({ path: stub }));
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}

function fakeChrome(tabs) {
  const calls = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => tabs[id] ?? Promise.reject(new Error("gone")),
      update: async (id, change) => (calls.push(["tab", id, change]), tabs[id]),
    },
    windows: { update: async (id, change) => calls.push(["window", id, change]) },
  };
  return calls;
}

test("background tabs are listed without touching the user's tab, and one click jumps", async (t) => {
  const ux = await load(t);
  globalThis.__mine = { c1: [7, 8, 9, 3] };
  const calls = fakeChrome({
    7: {
      id: 7,
      windowId: 2,
      active: false,
      url: "https://outlook.live.com/mail/1",
      title: "Invoice",
    },
    8: { id: 8, windowId: 2, active: false, url: "https://www.linkedin.com/in/x", title: "X" },
    9: { id: 9, windowId: 2, active: false, url: "chrome://newtab", title: "New" },
    3: { id: 3, windowId: 1, active: true, url: "https://example.com", title: "Mine" },
  });
  const tabs = await ux.runTabs("c1", 3);
  assert.deepEqual(
    tabs.map((tab) => [tab.tabId, tab.host]),
    [
      [7, "outlook.live.com"],
      [8, "linkedin.com"],
    ],
  );
  assert.equal(calls.length, 0, "listing never activates a tab");
  assert.equal(await ux.jumpToRunTab(8), true);
  assert.deepEqual(calls, [
    ["tab", 8, { active: true }],
    ["window", 2, { focused: true }],
  ]);
  assert.equal(await ux.jumpToRunTab(99), false);

  let jumped;
  const pills = renderToStaticMarkup(
    createElement(ux.RunTabPills, { tabs, onJump: (id) => (jumped = id) }),
  );
  assert.match(pills, /isl-run-tabs/);
  assert.match(pills, />Invoice</);
  assert.match(pills, />X</);
  assert.equal(renderToStaticMarkup(createElement(ux.RunTabPills, { tabs: [], onJump() {} })), "");
  assert.equal(jumped, undefined);
});

test("the working line is one calm timed phrase", async (t) => {
  const ux = await load(t);
  assert.equal(
    ux.workingLine("Reading\n  the inbox", 1_000, 5_400),
    "Working · 4s — Reading the inbox",
  );
  assert.equal(ux.workingLine("Reading", undefined), "Reading");
  const pill = renderToStaticMarkup(
    createElement(ux.WorkingPill, { text: "Reading", startedAt: Date.now() - 2_000 }),
  );
  assert.match(pill, /Working · 2s — Reading/);
  assert.doesNotMatch(pill, /<br|\n/);
});

test("Escape and a click outside tuck the box away; pills use design tokens only", async () => {
  const page = await readFile(src + "orb/orb-page.ts", "utf8");
  assert.match(page, /event\.key === "Escape"\) toContent\(\{ kind: "graft\.orb\.hide"/);
  const overlay = await readFile(src + "orb/orb-overlay.ts", "utf8");
  assert.match(overlay, /addEventListener\("pointerdown", this\.clickAway, \{ capture: true \}\)/);
  assert.match(
    overlay,
    /composedPath\(\)\.includes\(this\.host\)\) return;\s*this\.hideBubble\(\)/,
  );
  const css = await readFile(fileURLToPath(new URL("../orb.css", import.meta.url)), "utf8");
  const block = css.slice(css.indexOf(".isl-run-tabs {"), css.indexOf(".isl-tabs-empty"));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgb|hsl/i);
});
