import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, runAbility, saveAbility } from "../dist/abilities.js";
import { wayId } from "../dist/ability-stats.js";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-shape-"));
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

function base(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "feed",
    site: "example.com",
    kind: "read",
    inputs: {},
    ways: [
      {
        kind: "api",
        operation: "feed",
        expect: {
          shape: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
      { kind: "page", collect: { row: "body", fields: {} } },
    ],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const fallback = { kind: "page", collect: { row: "body", fields: {} } };
const collect = async () => ({ fallback: true });

test("a way that changed shape falls through to the next way and is marked unverified", async () => {
  await withHome(async () => {
    await saveAbility(base());
    const run = await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({ wrong: true }), collect } },
    );
    assert.equal(run.via, "page");
    assert.equal(run.result.fallback, true);
    assert.match(run.tried[0].error, /^unverified: the recorded shape changed/);
    assert.equal(run.unverified[0].via, "api");
    const stored = await readAbility("example.com", "feed");
    assert.equal(stored.ways.length, 2, "the drifted way is kept");
    const api = stored.stats.ways[wayId(stored.ways[0])];
    assert.equal(api.unverified, true);
    assert.match(api.unverifiedWhy, /id \(required\) missing/);
    const caps = await siteCapabilities("example.com");
    assert.equal(caps.abilities[0].unverified[0].via, "api");
  });
});

test("a recorded list must be there; an empty list is a result", async () => {
  await withHome(async () => {
    await saveAbility(
      base({
        ways: [{ kind: "api", operation: "feed", expect: { list: "/items" } }, fallback],
      }),
    );
    const missing = await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({}), collect } },
    );
    assert.equal(missing.via, "page");
    assert.match(missing.unverified[0].reason, /recorded list at \/items is missing/);

    const empty = await runAbility(
      "example.com",
      "feed",
      {},
      { via: "api", host: { call: async () => ({ items: [] }), collect } },
    );
    assert.equal(empty.via, "api");
    assert.deepEqual(empty.result, { items: [] });
    assert.equal(empty.unverified, undefined);
  });
});

test("a shape needs two verified answers before a missing field is drift", async () => {
  await withHome(async () => {
    await saveAbility(base({ ways: [{ kind: "api", operation: "feed" }, fallback] }));
    let answer = { id: "a", price: 10 };
    const host = { call: async () => answer, collect };

    const first = await runAbility("example.com", "feed", {}, { host });
    assert.equal(first.via, "api");
    const learned = await readAbility("example.com", "feed");
    const api = learned.stats.ways[wayId(learned.ways[0])];
    assert.ok(api.shape, "the shape was recorded");
    assert.equal(api.shape.required, undefined, "one answer cannot make a field required");
    assert.equal(api.shapeSamples, 1);

    answer = { id: "b", price: 12 };
    const second = await runAbility("example.com", "feed", {}, { host });
    assert.equal(second.via, "api");
    const twice = await readAbility("example.com", "feed");
    assert.deepEqual(
      twice.stats.ways[wayId(twice.ways[0])].shape.required.sort(),
      ["id", "price"],
      "fields present twice become required",
    );

    answer = { price: 99, extra: true };
    const third = await runAbility("example.com", "feed", {}, { host });
    assert.equal(third.via, "page");
    assert.equal(third.unverified[0].via, "api");

    // A value change is not drift: asking the api way again accepts the same shape.
    answer = { id: "c", price: 13 };
    const fourth = await runAbility("example.com", "feed", {}, { via: "api", host });
    assert.equal(fourth.via, "api");
    const after = await readAbility("example.com", "feed");
    const again = after.stats.ways[wayId(after.ways[0])];
    assert.equal(again.unverified, undefined, "a matching answer clears the mark");
  });
});

test("a field that comes and goes is learned as optional, so a normal answer is not drift", async () => {
  await withHome(async () => {
    await saveAbility(base({ ways: [{ kind: "api", operation: "feed" }, fallback] }));
    let answer = { items: [{ id: "a" }], next: "page-2" };
    const host = { call: async () => answer, collect };

    await runAbility("example.com", "feed", {}, { host });
    answer = { items: [{ id: "b" }] };
    const lastPage = await runAbility("example.com", "feed", {}, { host });
    assert.equal(lastPage.via, "api", "the last page without next is still the api way");
    assert.equal(lastPage.unverified, undefined);
    const learned = await readAbility("example.com", "feed");
    const api = learned.stats.ways[wayId(learned.ways[0])];
    assert.deepEqual(api.shape.required, ["items"]);
    assert.equal(api.shapeSamples, 2);

    answer = { items: [{ id: "c" }], next: "page-3" };
    const again = await runAbility("example.com", "feed", {}, { via: "api", host });
    assert.equal(again.unverified, undefined);

    answer = { next: "page-4" };
    const broken = await runAbility("example.com", "feed", {}, { host });
    assert.equal(broken.via, "page", "a missing required list is still drift");
    assert.match(broken.unverified[0].reason, /the recorded list at \/items is missing/);
  });
});

test("when every way drifts the answer is returned with unverified, not thrown away", async () => {
  await withHome(async () => {
    await saveAbility(base({ ways: [base().ways[0]] }));
    const run = await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({ something: "else" }), collect } },
    );
    assert.deepEqual({ ...run.result }, { something: "else" });
    assert.equal(run.via, "api");
    assert.equal(run.unverified[0].via, "api");
    assert.ok(await readAbility("example.com", "feed"), "the ability is still stored");
  });
});

test("a declared expectation is authoritative and is not overwritten", async () => {
  await withHome(async () => {
    const declared = base().ways[0];
    await saveAbility(base({ ways: [declared] }));
    await runAbility(
      "example.com",
      "feed",
      {},
      { host: { call: async () => ({ id: "a" }), collect } },
    );
    const stored = await readAbility("example.com", "feed");
    assert.equal(stored.stats.ways[wayId(stored.ways[0])].shape, undefined);
  });
});
