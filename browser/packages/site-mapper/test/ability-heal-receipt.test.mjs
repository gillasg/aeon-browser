// Drift, fallback, repair: a way's answer changes shape, the ability falls through to the next
// way, a later save repairs it, and the repair comes back as a receipt (v1 → v2) on the save, on
// the next run (once), and in the site's capabilities.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, runAbility, saveAbility } from "../dist/abilities.js";
import { abilityDirectory, abilitySlug } from "../dist/ability-files.js";
import {
  healLine,
  lastHeal,
  pendingHeal,
  queueHeal,
  readHealState,
  versionLabel,
} from "../dist/index.js";
import { wayId } from "../dist/ability-stats.js";
import { abilityVersionNumber, listAbilityVersions } from "../dist/ability-versions.js";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-heal-"));
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

const shape = (field) => ({
  shape: { type: "object", properties: { [field]: { type: "string" } }, required: [field] },
});
const page = { kind: "page", collect: { row: "body", fields: {} } };
const collect = async () => ({ fallback: true });

function feed(operation, field) {
  const now = new Date().toISOString();
  return {
    name: "feed",
    site: "example.com",
    kind: "read",
    inputs: {},
    ways: [{ kind: "api", operation, expect: shape(field) }, page],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("drift, fallback and repair give a v1 → v2 receipt", async () => {
  await withHome(async () => {
    const first = await saveAbility(feed("feed", "id"));
    assert.equal(first.ability.version, 1);
    assert.equal(first.healed, undefined);
    const driftedWay = wayId(first.ability.ways[0]);

    // The site renamed the field: the api way's answer no longer matches, the page way answers.
    const fallback = await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({ identifier: "1" }), collect } },
    );
    assert.equal(fallback.via, "page");
    assert.equal(fallback.healed, undefined, "nothing is repaired yet");
    const pending = await pendingHeal("example.com", "feed");
    assert.equal(pending.way, driftedWay);
    assert.match(pending.reason, /contract: the recorded shape changed/);

    // The repair: the api way points at the new operation and the new field.
    const repaired = await saveAbility(feed("feedV2", "identifier"), { replace: true });
    assert.equal(repaired.ability.version, 2);
    assert.deepEqual(
      { ...repaired.healed, at: undefined },
      {
        fromVersion: 1,
        toVersion: 2,
        fromWay: driftedWay,
        toWay: wayId(repaired.ability.ways[0]),
        reason: pending.reason,
        at: undefined,
      },
    );
    assert.match(repaired.healed.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(healLine("feed", repaired.healed), "Repaired feed (v1 → v2)");
    assert.equal(await pendingHeal("example.com", "feed"), undefined, "the drift is settled");
    assert.equal((await lastHeal("example.com", "feed")).toVersion, 2);

    // The old content is kept, and is the version the receipt says was replaced.
    const archived = await listAbilityVersions("example.com", "feed");
    assert.equal(archived.length, 1);

    // The next run says so once.
    const run = await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({ identifier: "1" }), collect } },
    );
    assert.equal(run.via, "api");
    assert.equal(run.healed.fromVersion, 1);
    assert.equal(run.healed.toVersion, 2);
    const again = await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({ identifier: "1" }), collect } },
    );
    assert.equal(again.healed, undefined, "announced once");

    // The site's capabilities carry the version and the last repair.
    const caps = await siteCapabilities("example.com");
    assert.equal(caps.abilities[0].version, 2);
    assert.equal(caps.abilities[0].healed.fromVersion, 1);
  });
});

test("a save that changes nothing keeps the version and heals nothing", async () => {
  await withHome(async () => {
    await saveAbility(feed("feed", "id"));
    await queueHeal("example.com", "feed", "api:x", "contract: id missing");
    const same = await saveAbility(feed("feed", "id"), { replace: true });
    assert.equal(same.ability.version, 1);
    assert.equal(same.healed, undefined);
    assert.ok(await pendingHeal("example.com", "feed"), "the drift still waits for a repair");
  });
});

test("a change with no drift waiting is an edit, not a repair", async () => {
  await withHome(async () => {
    await saveAbility(feed("feed", "id"));
    const edited = await saveAbility(feed("feedV2", "id"), { replace: true });
    assert.equal(edited.ability.version, 2);
    assert.equal(edited.healed, undefined);
  });
});

test("a bot wall is not drift, so nothing waits for a repair", async () => {
  await withHome(async () => {
    await queueHeal("example.com", "feed", "api:x", "SITE_BLOCKED: bot wall");
    assert.deepEqual(await readHealState("example.com"), {});
  });
});

test("versions keep counting past the history cap", async () => {
  await withHome(async () => {
    let last;
    for (let index = 0; index < 13; index++)
      last = await saveAbility(feed(`feed${index}`, "id"), { replace: true });
    assert.equal(last.ability.version, 13);
    assert.equal((await readAbility("example.com", "feed")).version, 13);
    assert.equal(versionLabel(last.ability.version), "v13");
  });
});

test("an ability saved before versions were stamped is numbered by its archive", async () => {
  await withHome(async () => {
    await saveAbility(feed("feed", "id"));
    await saveAbility(feed("feedV2", "id"), { replace: true });
    const stored = await readAbility("example.com", "feed");
    const { version, ...legacy } = stored;
    assert.equal(version, 2);
    assert.equal(await abilityVersionNumber(legacy), 2, "one archived save, so this is v2");
    // The next save stamps it and carries on from there.
    await writeFile(
      join(abilityDirectory("example.com"), abilitySlug("feed") + ".json"),
      JSON.stringify(legacy),
    );
    const next = await saveAbility(feed("feedV3", "id"), { replace: true });
    assert.equal(next.ability.version, 3);
  });
});
