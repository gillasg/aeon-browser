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
  await writeFile(
    stub,
    [
      'import { createElement } from "react";',
      "export function ChatSwitcher() { return null; }",
      "export function xrayParts() { return []; }",
      'export const piSlashCommandsKey = "graftPiSlashCommands";',
      "export function useAgentFlag() { return [false, () => {}]; }",
      "export function AnswerLines(props) {",
      "  if (!props.footer) return null;",
      '  const text = props.footer.lines.map((line) => line.text || line.label).join(" ");',
      '  return createElement("div", { className: "answer-lines" }, text);',
      "}",
      "",
    ].join("\n"),
  );
  const outfile = join(directory, "view.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/orb/orb-view.tsx", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"],
    alias: { "@graft/ui": stub },
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
  answerOffer() {},
  answerWrong() {},
  toggleLearning() {},
  retry() {},
  promote() {},
  copyAnswer() {},
  dismissHint() {},
  removeContext() {},
  pickTabs() {},
  addContext() {},
};

test("a running step is one breathing pill above the field, with no panel link", async () => {
  const orb = await view();
  const html = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: {
        ...model,
        startedAt: Date.now() - 4000,
        line: { text: "Reading your orders · 23 found", more: false },
      },
      actions,
    }),
  );
  assert.match(html, /data-state="working"/);
  assert.match(html, /class="isl-working"/);
  assert.match(html, /ink-dots" data-live="true"/);
  assert.match(html, /Reading your orders/);
  assert.match(html, /Working · 4s — Reading your orders/, "one calm timed line");
  assert.doesNotMatch(html, /isl-line-more/);
  assert.match(html, /<textarea/);
});

test("an error is a neutral card with its whole cause, Retry and Open in panel", async () => {
  const orb = await view();
  const cause = "Steam asked for a sign-in before it would show the editions list.";
  const html = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: { ...model, line: { title: "Couldn't finish", text: cause, more: true } },
      actions,
    }),
  );
  assert.match(html, /data-state="error"/);
  assert.match(html, /isl-error/);
  assert.match(html, new RegExp(cause));
  assert.match(html, />Retry</);
  assert.match(html, />Open in panel</);
  assert.doesNotMatch(html, /data-clamp/);
});

const footer = {
  lines: [
    {
      kind: "receipt",
      receipt: "speed",
      lead: "0.4 s via skill",
      rest: ["no model"],
      text: "0.4 s via skill · no model",
      short: "0.4 s · via skill",
    },
    { kind: "learned", text: "Learned: orders" },
  ],
};

test("a finished answer shows the echo, the prose and a hover-only time + Copy foot", async () => {
  const orb = await view();
  const done = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: {
        ...model,
        asked: "How many orders?",
        startedAt: new Date(2026, 10, 25, 13, 47, 0).getTime(),
        durationMs: 400,
        line: { text: "Twenty three orders.", more: true },
        footer,
      },
      actions,
    }),
  );
  assert.match(done, /data-state="answer"/);
  assert.match(done, /isl-answer/);
  assert.match(done, /class="isl-echo-text">How many orders\?</);
  assert.match(done, /class="isl-foot-time">13:47</);
  assert.match(done, /aria-label="Copy"/);
  assert.doesNotMatch(done, /via skill|no model|0\.4s|Retry|Wrong answer|Learned/);
  const running = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: { ...model, line: { text: "Reading your orders · 23 found", more: false }, footer },
      actions,
    }),
  );
  assert.doesNotMatch(running, /isl-foot/);
});

test("Compose never shows the X-Ray strip or the power row", async () => {
  const orb = await view();
  const html = renderToStaticMarkup(
    createElement(orb.OrbBox, {
      model: {
        ...model,
        chatId: undefined,
        xray: { apis: 4, boosts: 1, watches: 1 },
        fillForm: true,
        context: [{ tabId: 1, title: "Shop", host: "shop.com" }],
      },
      actions,
    }),
  );
  assert.doesNotMatch(html, /isl-xray|isl-power|Boost this site/);
  assert.doesNotMatch(html, /Fill this form|isl-whisper|Type \//);
  assert.match(html, /isl-context/);
  // The site chip is a cap above the input row, never inline beside the field.
  const chip = html.indexOf("isl-context");
  const row = html.indexOf("isl-input");
  assert.ok(chip >= 0 && row > chip, "isl-context renders before (above) isl-input");
  assert.doesNotMatch(html.slice(row), /isl-context/);
});

test("Teach folds the box to its pill", async () => {
  const orb = await view();
  const html = renderToStaticMarkup(
    createElement(orb.OrbBox, { model: { ...model, learning: true, learnFound: 3 }, actions }),
  );
  assert.match(html, /data-state="teach"/);
  assert.match(html, /Teaching · 3 APIs/);
  assert.doesNotMatch(html, /<textarea/);
});
