import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

async function loadRun() {
  const directory = await mkdtemp(join(tmpdir(), "aeon-orb-run-"));
  const outfile = join(directory, "orb-run.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/orb/orb-run.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

const orb = await loadRun();

function play(events, start = 1000) {
  return events.reduce(
    (run, [event, at]) => orb.applyEvent(run, event, at ?? start),
    orb.initialRun(),
  );
}

const start = (id, name, args = {}, extra = {}) => ({
  kind: "tool-start",
  toolCallId: id,
  toolName: name,
  arguments: args,
  ...extra,
});
const end = (id, name, extra = {}) => ({
  kind: "tool-end",
  toolCallId: id,
  toolName: name,
  result: "ok",
  isError: false,
  ...extra,
});
const assistant = (text) => ({
  kind: "message-end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
});
const toolMessage = (id, actions) => ({
  kind: "entry-added",
  entry: {
    entryId: "e-" + id,
    parentEntryId: null,
    category: "message",
    timestamp: "2026-10-21T10:00:00.000Z",
    message: { role: "tool", toolCallId: id, toolName: "browser_code", content: [], actions },
  },
});

test("tool-end path and durationMs are used as sent", () => {
  const run = play([
    [start("a", "site_api", { description: "Search Amazon" })],
    [end("a", "site_api", { path: "site-api", durationMs: 1234 }), 9999],
  ]);
  assert.equal(run.status, "working");
  assert.equal(run.label, "Search Amazon");
  assert.deepEqual(
    { path: run.steps[0].path, ms: run.steps[0].durationMs, mocked: run.steps[0].pathMocked },
    { path: "site-api", ms: 1234, mocked: false },
  );
  assert.equal(run.steps[0].durationMocked, false);
});

test("missing path is inferred and missing durationMs comes from start and end", () => {
  const run = play([
    [start("a", "crawl"), 1000],
    [end("a", "crawl"), 3500],
    [start("b", "browser_code"), 3600],
    [end("b", "browser_code"), 4100],
  ]);
  assert.deepEqual(
    run.steps.map((step) => [step.path, step.pathMocked, step.durationMs, step.durationMocked]),
    [
      ["data", true, 2500, true],
      ["ui", true, 500, true],
    ],
  );
  assert.equal(run.steps[1].label, "Working in the page");
  assert.equal(orb.summarize(run), "2 steps · 3.0s · via data, the page");
});

test("nested tool calls do not become steps", () => {
  const run = play([
    [start("a", "browser_code")],
    [start("n", "site_api", {}, { parentToolCallId: "a" })],
    [end("n", "site_api", { parentToolCallId: "a" })],
  ]);
  assert.equal(run.steps.length, 1);
});

test("an idle chat before the prompt starts is not a finished run", () => {
  assert.equal(play([[{ kind: "run-state", state: "idle" }]]).status, "thinking");
  const run = play([[assistant("Ordered it.")], [{ kind: "turn-boundary", active: false }]]);
  assert.equal(run.status, "done");
  assert.equal(run.answer, "Ordered it.");
});

test("a question for the user is needs-you until it is answered", () => {
  const asked = play([
    [
      {
        kind: "extension-ui-request",
        request: {
          requestId: "8c0f0a7e-6a3b-4f7e-9b5e-1d2c3b4a5f60",
          kind: "confirm",
          title: "Place order · $129?",
          message: null,
          options: [],
          placeholder: null,
          prefill: null,
          expiresAt: "2026-10-21T10:05:00.000Z",
        },
      },
    ],
  ]);
  assert.equal(asked.status, "needs");
  assert.equal(asked.dialog.title, "Place order · $129?");
  const resolved = orb.applyEvent(
    asked,
    { kind: "extension-ui-resolved", requestId: "8c0f0a7e-6a3b-4f7e-9b5e-1d2c3b4a5f60" },
    0,
  );
  assert.equal(resolved.status, "working");
  assert.equal("dialog" in resolved, false);
});

test("trace actions drive the cursor and the spotlight for this tab only", () => {
  const run = play([
    [start("a", "browser_code")],
    [
      toolMessage("a", [
        { kind: "click", tabId: 7, tStart: 100, tAct: 120, tEnd: 200, point: { x: 10, y: 20 } },
        {
          kind: "fill",
          tabId: 7,
          tStart: 5000,
          tEnd: 5100,
          box: { x: 100, y: 200, width: 40, height: 20 },
        },
        { kind: "click", tabId: 9, tStart: 5200, tEnd: 5300, point: { x: 1, y: 1 } },
        { kind: "click", visible: false, tStart: 5400, tEnd: 5500, point: { x: 2, y: 2 } },
        { kind: "scroll", tStart: 5600, tEnd: 5700 },
      ]),
    ],
  ]);
  assert.deepEqual(orb.cursorSteps(run.actions, 7), [
    { kind: "click", x: 10, y: 20, delayMs: 0 },
    { kind: "fill", x: 120, y: 210, delayMs: 1200 },
  ]);
  assert.deepEqual(orb.spotlightBox(run.actions, 7), { x: 100, y: 200, width: 40, height: 20 });
  // A second copy of the same tool message adds nothing.
  const again = orb.applyEvent(run, toolMessage("a", [{ kind: "click", tStart: 1, tEnd: 2 }]), 0);
  assert.equal(again.actions.length, run.actions.length);
});

test("an assistant error ends the run as an error", () => {
  const run = play([
    [
      {
        kind: "message-end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "No model" },
      },
    ],
  ]);
  assert.equal(run.status, "error");
  assert.equal(run.error, "No model");
});
