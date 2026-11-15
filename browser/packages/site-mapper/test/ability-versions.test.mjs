import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, saveAbility } from "../dist/abilities.js";
import { maintainAbilities } from "../dist/abilities.js";
import {
  ABILITY_HISTORY_LIMIT,
  countAbilityVersions,
  listAbilityVersions,
  readAbilityVersion,
} from "../dist/ability-versions.js";
import { restoreAbility } from "../dist/ability-restore.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-versions-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function ability(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    description: "Find products",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("a content change keeps the previous save, and restore makes it live again", async () => {
  await withHome(async () => {
    await saveAbility(ability({ description: "first" }));
    await saveAbility(ability({ description: "second" }));
    const versions = await listAbilityVersions("example.com", "search");
    assert.equal(versions.length, 1);
    assert.deepEqual(versions[0].ways, ["api"]);
    const version = await readAbilityVersion("example.com", "search", versions[0].at);
    assert.equal(version.description, "first");

    const restored = await restoreAbility("example.com", "search", versions[0].at);
    assert.equal(restored.ability.description, "first");
    assert.equal((await readAbility("example.com", "search")).description, "first");
    assert.equal((await countAbilityVersions("example.com", "search")).count, 2);
  });
});

test("a stats-only save is not a version", async () => {
  await withHome(async () => {
    await saveAbility(ability());
    await saveAbility(ability({ stats: { runs: 7, failures: 1 } }));
    assert.equal((await listAbilityVersions("example.com", "search")).length, 0);
  });
});

test("history is capped per ability", async () => {
  await withHome(async () => {
    for (let index = 0; index < ABILITY_HISTORY_LIMIT + 4; index++)
      await saveAbility(ability({ description: `save ${index}` }));
    const versions = await listAbilityVersions("example.com", "search");
    assert.equal(versions.length, ABILITY_HISTORY_LIMIT);
    const descriptions = await Promise.all(
      versions.map(async (version) => {
        const old = await readAbilityVersion("example.com", "search", version.at);
        return old.description;
      }),
    );
    assert.ok(descriptions.includes(`save ${ABILITY_HISTORY_LIMIT + 2}`));
    assert.ok(!descriptions.includes("save 0"));
  });
});

test("restore obeys the same caller contract as a save", async () => {
  await withHome(async () => {
    await saveAbility(ability());
    const before = (await listAbilityVersions("example.com", "search")).length;
    assert.equal(before, 0);
    await saveAbility(
      ability({
        inputs: { type: "object", properties: { q: { type: "string" }, page: { type: "number" } } },
        ways: [
          {
            kind: "api",
            operation: "search",
            params: { q: "{{inputs.q}}", page: "{{inputs.page}}" },
          },
        ],
      }),
    );
    const [version] = await listAbilityVersions("example.com", "search");
    await assert.rejects(
      restoreAbility("example.com", "search", version.at),
      /ABILITY_CONTRACT_WEAKENED: search: input page removed/,
    );
    const forced = await restoreAbility("example.com", "search", version.at, { breaking: true });
    assert.deepEqual(Object.keys(forced.ability.inputs.properties), ["q"]);
  });
});

test("a restore starts the live copy with fresh run stats and a new age", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({ stats: { runs: 9, failures: 4, lastUsedAt: "2026-01-01T00:00:00.000Z" } }),
    );
    await saveAbility(ability({ description: "newer", createdAt: "2026-01-01T00:00:00.000Z" }));
    const [version] = await listAbilityVersions("example.com", "search");
    const restored = await restoreAbility("example.com", "search", version.at);
    assert.deepEqual(restored.ability.stats, { runs: 0, failures: 0 });
    assert.ok(Date.parse(restored.ability.createdAt) > Date.now() - 60_000);
    assert.deepEqual((await maintainAbilities("example.com")).trashed, []);
  });
});

test("an unknown version is refused without touching the current file", async () => {
  await withHome(async () => {
    await saveAbility(ability());
    await assert.rejects(
      restoreAbility("example.com", "search", "2026-01-01T00-00-00-000Z"),
      /ABILITY_VERSION_UNKNOWN/,
    );
    assert.equal((await readAbility("example.com", "search")).description, "Find products");
  });
});
