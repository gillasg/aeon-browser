import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, saveAbility } from "../dist/abilities.js";
import { listAbilityVersions } from "../dist/ability-versions.js";
import {
  IdleScheduler,
  classifyFailure,
  repairAbilityWhileIdle,
  withCheckNote,
} from "../dist/ability-idle.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-idle-"));
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
  const now = "2026-11-17T10:00:00.000Z";
  return {
    name: "orders",
    site: "shop.example",
    kind: "read",
    description: "check my orders",
    inputs: { type: "object", properties: {} },
    ways: [{ kind: "script", runtime: "page", code: "async (page, bu, inputs) => { return 1; }" }],
    options: {},
    stats: { runs: 3, failures: 0, lastOkAt: now },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("drift is told apart from sign-out, bot walls and rate limits", () => {
  assert.equal(classifyFailure("contract: items list is gone"), "drift");
  assert.equal(classifyFailure("response shape changed: missing id"), "drift");
  assert.equal(classifyFailure("SIGNED_OUT: please sign in again"), "signout");
  assert.equal(classifyFailure("401 unauthorized, re-auth needed"), "signout");
  assert.equal(classifyFailure("bot wall / captcha challenge"), "bot");
  assert.equal(classifyFailure("RATE_LIMITED 429 too many requests"), "rate_limit");
});

test("pacing allows a few checks per hour then refuses until the window moves", () => {
  let now = 1_000_000;
  const scheduler = new IdleScheduler({ perHour: 2, batchSize: 2 }, { now: () => now });
  assert.equal(scheduler.canStart(), true);
  scheduler.recordCheck();
  scheduler.recordCheck();
  assert.equal(scheduler.remaining, 0);
  assert.equal(scheduler.canStart(), false);
  now += 3_600_001;
  assert.equal(scheduler.remaining, 2);
  assert.equal(scheduler.canStart(), true);
});

test("a running chat stops idle work immediately, and battery pauses it", () => {
  let battery = false;
  const scheduler = new IdleScheduler({}, { onBattery: () => battery });
  assert.equal(scheduler.canStart(), true);
  scheduler.noteChatStart();
  assert.equal(scheduler.canStart(), false);
  assert.deepEqual(scheduler.plan([ability()]), []);
  scheduler.noteChatEnd();
  assert.equal(scheduler.canStart(), true);
  battery = true;
  assert.equal(scheduler.canStart(), false);
  battery = undefined;
  assert.equal(scheduler.canStart(), true);
});

test("one site at a time, then the next site after release", () => {
  const scheduler = new IdleScheduler({ perHour: 6, batchSize: 4 });
  assert.equal(scheduler.claimSite("one.example"), true);
  assert.equal(scheduler.claimSite("two.example"), false);
  assert.equal(scheduler.claimSite("one.example"), false);
  scheduler.releaseSite("one.example");
  assert.equal(scheduler.claimSite("two.example"), true);
});

test("the plan picks a few abilities, one per site, least-recently-checked first", () => {
  const scheduler = new IdleScheduler({ perHour: 6, batchSize: 2 });
  const old = withCheckNote(ability({ name: "old" }), {
    at: "2026-01-01T00:00:00.000Z",
    ok: true,
    reason: "drift",
    detail: "checked",
  });
  const plan = scheduler.plan([
    ability({ name: "fresh", site: "b.example" }),
    old,
    ability({ name: "other", site: "c.example" }),
    ability({ name: "writes", site: "d.example", kind: "write" }),
  ]);
  // Never-checked abilities come first; a stale check comes before a recent one at a larger batch.
  assert.deepEqual(
    plan.map((entry) => entry.name),
    ["fresh", "other"],
  );
  const wider = new IdleScheduler({ perHour: 6, batchSize: 3 });
  assert.deepEqual(
    wider
      .plan([
        withCheckNote(ability({ name: "recent", site: "a.example" }), {
          at: "2026-11-17T09:00:00.000Z",
          ok: true,
          reason: "drift",
          detail: "checked",
        }),
        old,
        ability({ name: "fresh", site: "b.example" }),
      ])
      .map((entry) => entry.name),
    ["fresh", "old", "recent"],
  );
});

test("a sign-out is recorded, never re-learned", async () => {
  await withHome(async () => {
    let relearned = 0;
    const result = await repairAbilityWhileIdle(ability(), {
      check: async () => ({ ok: false, reason: "SIGNED_OUT" }),
      relearn: async () => {
        relearned++;
        return undefined;
      },
    });
    assert.equal(result.status, "not-drift");
    assert.equal(result.note.reason, "signout");
    assert.equal(relearned, 0);
  });
});

test("a drifted ability is re-learned, saved as a new version, and the old one is kept", async () => {
  await withHome(async () => {
    const before = ability();
    await saveAbility(before);
    const fresh = ability({
      ways: [
        { kind: "script", runtime: "page", code: "async (page, bu, inputs) => { return 2; }" },
      ],
    });
    const result = await repairAbilityWhileIdle(before, {
      check: async () => ({ ok: false, reason: "contract: items list is gone" }),
      relearn: async () => fresh,
    });
    assert.equal(result.status, "repaired");
    const stored = await readAbility("shop.example", "orders");
    assert.match(stored.ways[0].code, /return 2/);
    assert.equal((await listAbilityVersions("shop.example", "orders")).length, 1);
    assert.equal(result.note.ok, true);
    assert.equal(result.healed.fromVersion, 1);
    assert.equal(result.healed.toVersion, 2);
    assert.match(result.healed.reason, /items list is gone/);
    assert.equal(stored.version, 2);
  });
});

test("a drift it cannot repair is marked so the next run knows", async () => {
  await withHome(async () => {
    const result = await repairAbilityWhileIdle(ability(), {
      check: async () => ({ ok: false, reason: "contract: shape changed" }),
      relearn: async () => undefined,
    });
    assert.equal(result.status, "unrepaired");
    assert.equal(result.note.repairFailed, true);
    assert.match(result.ability.options.abilityCheck.detail, /shape changed/);
  });
});
