import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

async function load(t) {
  const directory = await mkdtemp(join(tmpdir(), "graft-model-broadcast-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "broadcast.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/model-broadcast.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  return import(pathToFileURL(outfile).href);
}

const BASE = "chrome-extension://abc/home.html";

test("the Models page address remembers where to send the user back", async (t) => {
  const { modelsPageUrl, returnTarget } = await load(t);
  assert.equal(modelsPageUrl(BASE), `${BASE}?view=models`);
  assert.equal(modelsPageUrl(BASE, 42), `${BASE}?view=models&return=42`);
  assert.equal(returnTarget(modelsPageUrl(BASE, 42)), 42);
  assert.equal(returnTarget(modelsPageUrl(BASE, "panel")), "panel");
  assert.equal(returnTarget(modelsPageUrl(BASE)), undefined);
  assert.equal(returnTarget(`${BASE}?view=models&return=nope`), undefined);
  assert.equal(returnTarget(undefined), undefined);
});

test("a sign-in announced by one view reaches every other open view at once", async (t) => {
  const { announceModelsChanged, onModelsChanged } = await load(t);
  let heard = 0;
  const arrived = new Promise((resolve) => {
    const stop = onModelsChanged(() => {
      heard++;
      stop();
      resolve();
    });
  });
  announceModelsChanged();
  await arrived;
  assert.equal(heard, 1);
});
