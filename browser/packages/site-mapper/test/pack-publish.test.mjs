import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { exportSitePack } from "../dist/pack.js";

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), "browserkit-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function write(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function ability(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "shop.example",
    description: "Find a product",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    outputs: { type: "object", properties: { title: { type: "string" } } },
    ways: [{ kind: "script", runtime: "node", code: "void inputs.q; return { title: 'tea' };" }],
    tests: [{ inputs: { q: "tea" }, expect: { title: "tea" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function unzip(bytes) {
  const entries = unzipSync(bytes);
  return Object.fromEntries(Object.entries(entries).map(([path, data]) => [path, strFromU8(data)]));
}

async function site(t, abilityValue) {
  const home = await temp(t);
  const folder = join(home, "sites", "shop.example");
  await write(join(folder, "model.json"), { site: "shop.example", operations: [] });
  await write(join(folder, "abilities", "search.json"), abilityValue);
  process.env.SITE_TO_API_HOME = home;
  return { home, out: join(home, "shop.zip") };
}

test("a pack carries a public definition of each ability", async (t) => {
  const { out } = await site(t, ability());
  const exported = await exportSitePack({ site: "shop.example", out });
  assert.equal(exported.published, 1);
  assert.deepEqual(exported.findings, []);
  assert.ok(exported.files.includes("abilities/public/search.json"), exported.files.join(", "));
  const entries = unzip(await readFile(out));
  const definition = JSON.parse(entries["abilities/public/search.json"]);
  assert.equal(definition.effect, "read");
  assert.deepEqual(definition.ways, ["script"]);
  assert.equal(JSON.stringify(definition).includes("void inputs.q"), false);
});

test("a pack's runnable ability is scrubbed of lint findings before it ships", async (t) => {
  const leaky = ability({
    inputs: { type: "object", properties: { q: { type: "string", example: "tea" } } },
    ways: [
      {
        kind: "script",
        runtime: "node",
        code: "const headers = { authorization: 'Bearer ab12cd34ef56' }; void inputs.q; return { title: 'tea' };",
      },
      { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } },
    ],
  });
  const { out } = await site(t, leaky);
  const exported = await exportSitePack({ site: "shop.example", out, publish: "warn" });
  assert.ok(exported.findings.some((finding) => finding.code === "input_recorded_value"));
  const entries = unzip(await readFile(out));
  const runnable = JSON.parse(entries["abilities/search.json"]);
  // The credential-bearing script survives with its key templated to a caller input, so the way
  // is not lost and no secret ships in the pack.
  assert.deepEqual(
    runnable.ways.map((way) => way.kind),
    ["script", "api"],
  );
  assert.match(runnable.ways[0].code, /Bearer ['"] \+ inputs\["authToken"\] \+ ['"]/);
  assert.ok(runnable.inputs.properties.authToken, "the key is a caller input");
  assert.equal(runnable.inputs.properties.q.example, undefined, "the recorded value is redacted");
  assert.equal(entries["abilities/search.json"].includes("Bearer ab12"), false);
  const definition = JSON.parse(entries["abilities/public/search.json"]);
  assert.deepEqual(definition.ways, ["script", "api"]);
});

test("a private value the scrub cannot remove stops even a warned pack", async (t) => {
  const pinned = ability({
    tests: [{ inputs: { q: "tea", account_id: 42 }, expect: { title: "tea" } }],
  });
  const { out } = await site(t, pinned);
  await assert.rejects(
    exportSitePack({ site: "shop.example", out, publish: "warn" }),
    /ABILITY_NOT_PUBLISHABLE: search would ship a private value/,
  );
});

test("a personal value blocks the pack unless the caller allows an unreviewed one", async (t) => {
  const personal = ability({
    tests: [{ inputs: { q: "me@example.com" }, expect: { title: "tea" } }],
  });
  const { out } = await site(t, personal);
  await assert.rejects(
    exportSitePack({ site: "shop.example", out }),
    /ABILITY_NOT_PUBLISHABLE: error personal_data .*email address/,
  );

  const warned = await exportSitePack({ site: "shop.example", out, publish: "warn" });
  assert.equal(warned.published, 1);
  assert.equal(
    warned.findings.some((finding) => finding.code === "personal_data"),
    true,
  );
  const entries = unzip(await readFile(out));
  assert.equal(entries["abilities/search.json"].includes("me@example.com"), false);
  assert.equal(entries["abilities/public/search.json"].includes("me@example.com"), false);
});
