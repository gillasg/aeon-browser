import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  INFERENCE_VERSION,
  loadCurrentModel,
  loadModel,
  readSiteOps,
  rebuild,
  saveFlow,
  siteDir,
  siteMapper,
} from "../dist/index.js";
import { har, harEntry } from "./har-entries.mjs";
import { tempHome } from "./helpers.mjs";

const SITE = "books.example";

async function storedSite(t) {
  await tempHome(t);
  const entries = [1, 2, 3].map((id) =>
    harEntry(`https://${SITE}/api/books/${id}`, { json: { id, title: `Book ${id}` } }),
  );
  await saveFlow(SITE, { name: "browse", recordedAt: new Date().toISOString() }, har(entries));
  await rebuild(SITE);
}

test("a fresh build stamps the inference version on model.json", async (t) => {
  await storedSite(t);
  assert.equal(INFERENCE_VERSION >= 2, true);
  assert.equal((await loadModel(SITE)).inferenceVersion, INFERENCE_VERSION);
});

test("a model from older rules rebuilds itself in place from its stored flows", async (t) => {
  await storedSite(t);
  const path = join(siteDir(SITE), "model.json");
  const current = JSON.parse(await readFile(path, "utf8"));
  // What an older engine saved: no version stamp, and a stale shape (one op per id).
  const old = { ...current, operations: current.operations.slice(0, 1) };
  delete old.inferenceVersion;
  old.operations[0] = { ...old.operations[0], id: "oldStyleOp" };
  await writeFile(path, JSON.stringify(old, null, 2));

  const api = await siteMapper(SITE, { transports: { direct: { name: "direct" } } });
  assert.equal(api.model.inferenceVersion, INFERENCE_VERSION);
  assert.ok(!api.model.operations.some((op) => op.id === "oldStyleOp"));
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.inferenceVersion, INFERENCE_VERSION);
  assert.deepEqual(
    saved.operations.map((op) => op.id),
    current.operations.map((op) => op.id),
  );
});

test("a stale model with no flows, or a failing rebuild, is kept as it is", async (t) => {
  await tempHome(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(siteDir("bare.example"), { recursive: true });
  const old = { version: 1, site: "bare.example", operations: [{ id: "keep" }] };
  await writeFile(join(siteDir("bare.example"), "model.json"), JSON.stringify(old));
  assert.deepEqual(await loadCurrentModel("bare.example"), old);
  // A broken stored flow: the rebuild throws, the saved model stays.
  await saveFlow("bare.example", { name: "broken", recordedAt: "x" }, Buffer.from("not a har"));
  assert.deepEqual(await loadCurrentModel("bare.example"), old);
});

test("api.json follows model.json: a rebuilt model recompiles the ops file", async (t) => {
  await storedSite(t);
  const first = await readSiteOps(SITE);
  assert.ok(first.ops.some((op) => op.id === "getBook" || op.kind === "http"));
  const entries = [harEntry(`https://${SITE}/api/authors/7`, { json: { id: 7, name: "A" } })];
  await saveFlow(SITE, { name: "more", recordedAt: new Date().toISOString() }, har(entries));
  await new Promise((done) => setTimeout(done, 5));
  const { model } = await rebuild(SITE);
  const ops = (await readSiteOps(SITE)).ops.map((op) => op.id);
  for (const operation of model.operations) assert.ok(ops.includes(operation.id), operation.id);
});
