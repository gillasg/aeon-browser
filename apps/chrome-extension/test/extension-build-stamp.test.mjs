import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildVersion } from "../scripts/build-extension.mjs";

// Chrome keeps an extension's registered service worker while the manifest version is unchanged,
// and a worker that read build-info.json at run time matched every newer build on disk. The build
// now compiles its stamp into the worker and gives each build its own manifest version.

const dist = new URL("../native-dist/", import.meta.url);

test("the service worker carries the exact build-info.json it was built with", async () => {
  const info = await readFile(new URL("build-info.json", dist), "utf8");
  const { build } = JSON.parse(info);
  assert.match(build, /^[0-9a-f-]{36}$/);
  const worker = await readFile(new URL("service-worker.js", dist), "utf8");
  assert.ok(worker.includes(build), "the worker embeds this build's stamp");
});

test("each build gets its own rising manifest version and keeps the readable one", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
  assert.equal(manifest.version_name, "0.1.0");
  assert.match(manifest.version, /^0\.1\.\d{1,5}\.\d{1,5}$/);
  const day = Date.UTC(2026, 10, 22);
  assert.equal(buildVersion(day), `0.1.${day / 86_400_000}.0`);
  const parts = (v) => v.split(".").map(Number);
  const [a, b] = [buildVersion(day + 5_000), buildVersion(day + 86_399_000)].map(parts);
  assert.ok(a[3] < b[3]);
  assert.ok(parts(buildVersion(day + 86_400_000))[2] > a[2]);
  for (const part of b) assert.ok(part <= 65_535);
});
