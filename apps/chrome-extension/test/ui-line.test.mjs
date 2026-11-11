import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const protocol = fileURLToPath(
  new URL("../../../browser/packages/protocol/src/errors.ts", import.meta.url),
);

async function load(entry) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-ui-"));
  const outfile = join(directory, "bundle.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    alias: { "@aeon/protocol": protocol },
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

test("a failure title follows the owner, and an unknown code is ours", async () => {
  const titles = await load("../../../packages/ui/src/failure-title.ts");
  assert.equal(titles.failureTitle("TARGET_BLOCKED: covered"), "The site blocked this");
  assert.equal(titles.failureTitle("DEBUGGER_DETACHED: cancelled"), "I need you for one step");
  assert.equal(titles.failureTitle("TARGET_NOT_FOUND: missing"), "That was my mistake");
  assert.equal(titles.failureTitle("INPUT_FAILED: missed"), "Aeon broke");
  assert.equal(titles.failureTitle("No model"), "Aeon broke");
  assert.equal(titles.failureTitle("NOPE"), "Aeon broke");
});

test("the box line is the step while running and the answer when it ends", async () => {
  const lines = await load("../../../packages/ui/src/box-line.ts");
  const step = { text: "Reading your orders · 23 found", more: false };
  assert.equal(lines.boxLine({ status: "idle", label: "Thinking" }), null);
  assert.deepEqual(lines.boxLine({ status: "working", label: step.text }), step);
  assert.equal(lines.boxLine({ status: "thinking", label: "  " }), null);
  assert.deepEqual(lines.boxLine({ status: "needs", label: "Which size?" }), {
    text: "Which size?",
    more: false,
  });
  assert.deepEqual(lines.boxLine({ status: "error", label: "old", error: "No model" }), {
    title: "Aeon broke",
    text: "No model",
    more: true,
  });
  assert.deepEqual(lines.boxLine({ status: "done", label: "Done", answer: "The short answer" }), {
    text: "The short answer",
    more: true,
  });
});

test("an errored run keeps the owner title on its label", async () => {
  const model = await load("../../../packages/ui/src/run-model.ts");
  const run = model.applyEvent(
    model.initialRun(),
    {
      kind: "message-end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "No model" },
    },
    1,
  );
  assert.equal(run.status, "error");
  assert.equal(run.error, "No model");
  assert.equal(run.label, "Aeon broke");
});
