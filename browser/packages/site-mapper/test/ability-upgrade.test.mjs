import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, runAbility, saveAbility } from "../dist/abilities.js";
import { wayId } from "../dist/ability-stats.js";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-upgrade-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run();
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

const script = (code) => ({ kind: "script", runtime: "node", code });

test("reads record per-way stats and the next run starts with the way that worked", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        ways: [
          { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } },
          script("return 'from script'"),
        ],
      }),
    );
    let calls = 0;
    const host = {
      call: async () => {
        calls += 1;
        throw new Error("api down");
      },
    };
    const first = await runAbility("example.com", "search", { q: "tea" }, { host });
    assert.equal(first.via, "script");
    assert.equal(first.tried[0].via, "api");
    const second = await runAbility("example.com", "search", { q: "tea" }, { host });
    assert.equal(second.via, "script");
    assert.deepEqual(second.tried, []);
    assert.equal(calls, 1, "the broken way is not tried once another has succeeded");
    const stored = await readAbility("example.com", "search");
    const ways = Object.values(stored.stats.ways);
    assert.equal(ways.find((item) => item.failures === 1).runs, 1);
    const ok = ways.find((item) => item.lastOkAt);
    assert.equal(ok.failures, 0);
    assert.equal(typeof ok.p50Ms, "number");
  });
});

test("three failures in a row skip a way until its retry, unless the caller names it", async () => {
  await withHome(async () => {
    const way = { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } };
    await saveAbility(ability({ ways: [way] }));
    let calls = 0;
    const host = {
      call: async () => {
        calls += 1;
        throw new Error("api down");
      },
    };
    for (let n = 0; n < 3; n++)
      await assert.rejects(runAbility("example.com", "search", { q: "tea" }, { host }), /api down/);
    assert.equal(calls, 3);
    await assert.rejects(
      runAbility("example.com", "search", { q: "tea" }, { host }),
      /skipped until/,
    );
    assert.equal(calls, 3, "a way in backoff is not called");
    const stored = await readAbility("example.com", "search");
    const stats = stored.stats.ways[wayId(way)];
    assert.equal(stats.failures, 3);
    assert.ok(Date.parse(stats.retryAt) > Date.now());
    await saveAbility(
      {
        ...stored,
        stats: {
          ...stored.stats,
          ways: { [wayId(way)]: { ...stats, retryAt: new Date(0).toISOString() } },
        },
      },
      { check: false },
    );
    await assert.rejects(runAbility("example.com", "search", { q: "tea" }, { host }), /api down/);
    assert.equal(calls, 4, "a way is tried again after its retry time");
  });
});

test("a new way that fails its test is refused and the saved ways stay", async () => {
  await withHome(async () => {
    const host = { call: async () => ({ title: "tea" }) };
    const tests = [{ inputs: { q: "tea" }, expect: { title: "tea" } }];
    await saveAbility(ability({ tests }), { host });
    await assert.rejects(
      saveAbility(
        ability({
          tests,
          ways: [
            { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } },
            script("return { title: 'nope' }"),
          ],
        }),
        { host },
      ),
      /ABILITY_TEST_FAILED: search new script way failed its test \(missing title\)/,
    );
    const kept = await readAbility("example.com", "search");
    assert.deepEqual(
      kept.ways.map((way) => way.kind),
      ["api"],
    );
    await assert.rejects(
      saveAbility(
        ability({
          name: "fresh",
          createdBy: "user",
          tests,
          ways: [script("return { title: 'nope' }")],
        }),
        { host },
      ),
      /ABILITY_TEST_FAILED/,
    );
    assert.equal(await readAbility("example.com", "fresh"), undefined);
  });
});

test("a new way that passes its test is saved, and a sample becomes the first test", async () => {
  await withHome(async () => {
    const host = { call: async () => ({ title: "tea" }) };
    const tests = [{ inputs: { q: "tea" }, expect: { title: "tea" } }];
    await saveAbility(ability({ tests }), { host });
    const saved = await saveAbility(
      ability({
        tests,
        ways: [
          { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } },
          script("return { title: 'tea' }"),
        ],
      }),
      { host },
    );
    assert.equal(saved.ability.ways.length, 2);
    assert.equal(saved.tests.ok, true);
    const sampled = await saveAbility(ability({ name: "sampled" }), {
      host,
      sample: { inputs: { q: "tea" }, result: { title: "tea" } },
    });
    assert.deepEqual(sampled.ability.tests, [{ inputs: { q: "tea" }, expect: { title: "tea" } }]);
  });
});

test("a partial way is marked, and a caller that needs everything skips it", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        inputs: {},
        createdBy: "user",
        ways: [
          { ...script("return { title: 'part', partial: true }"), partial: true },
          script("return { title: 'all' }"),
        ],
      }),
    );
    const part = await runAbility("example.com", "search", {}, {});
    assert.equal(part.partial, true);
    assert.equal(part.result.title, "part");
    const full = await runAbility("example.com", "search", {}, { complete: true });
    assert.equal(full.partial, undefined);
    assert.equal(full.result.title, "all");
    assert.match(full.tried[0].error, /partial/);
  });
});

test("a partial paged way yields to the next way when the caller wants everything", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        inputs: {},
        createdBy: "user",
        ways: [
          {
            kind: "api",
            operation: "feed",
            paging: { param: "cursor", next: "/next", items: "/items" },
            partial: true,
          },
          { kind: "page", collect: { row: "article", fields: { title: "h1" } } },
        ],
      }),
    );
    const host = {
      call: async () => ({ items: [{ id: "1" }], next: null }),
      collect: async () => ({ title: "all" }),
    };
    const full = await runAbility("example.com", "search", {}, { host, complete: true });
    assert.equal(full.via, "page");
    assert.equal(full.result.title, "all");
    assert.match(full.tried[0].error, /partial/);
  });
});

test("a way that misses the output contract is not the result", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        inputs: {},
        createdBy: "user",
        outputs: { type: "object", required: ["title"], properties: { title: {} } },
        ways: [script("return { price: 1 }"), script("return { title: 'tea' }")],
      }),
    );
    const run = await runAbility("example.com", "search", {}, {});
    assert.equal(run.result.title, "tea");
    assert.match(run.tried[0].error, /contract: missing title/);
  });
});

test("a second way that disagrees marks the ability stale", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        ways: [
          { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } },
          script("return [{ id: '9' }]"),
        ],
      }),
    );
    const host = { call: async () => [{ id: "1" }, { id: "2" }] };
    const stale = await runAbility("example.com", "search", { q: "tea" }, { host, differ: true });
    assert.equal(stale.result.length, 2);
    assert.equal(stale.stale, true);
    assert.match(stale.staleWhy, /missing/);
    await saveAbility(
      ability({
        name: "agree",
        ways: [
          { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } },
          script("return [{ id: '1' }]"),
        ],
      }),
    );
    const ok = await runAbility("example.com", "agree", { q: "tea" }, { host, differ: true });
    assert.equal(ok.stale, undefined);
    assert.equal((await readAbility("example.com", "agree")).stats.stale, undefined);
    assert.equal((await readAbility("example.com", "search")).stats.stale, true);
  });
});

test("writes stay in stored order and do not change way after a possible commit", async () => {
  await withHome(async () => {
    const api = { kind: "api", operation: "order", params: { item: "{{inputs.item}}" } };
    const page = script("return 'by script'");
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: { type: "object", properties: { item: { type: "string" } } },
        ways: [api, page],
        stats: {
          runs: 1,
          failures: 0,
          lastOkAt: new Date().toISOString(),
          ways: { [wayId(page)]: { runs: 2, failures: 0, lastOkAt: new Date().toISOString() } },
        },
      }),
      { check: false },
    );
    let scripts = 0;
    const host = {
      call: async () => {
        throw new Error("request timed out");
      },
      script: async () => {
        scripts += 1;
      },
    };
    const failure = await runAbility("example.com", "order", { item: "tea" }, { host }).catch(
      (error) => error,
    );
    assert.equal(failure.outcome.possible_commit, true);
    assert.equal(scripts, 0);
    assert.doesNotMatch(failure.message, /by script/);
  });
});

test("a precondition stops a write before any way, and a postcondition reads the site back", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "search",
        inputs: {},
        createdBy: "user",
        ways: [script("return { title: 'tea' }")],
      }),
    );
    let calls = 0;
    await assert.rejects(
      runAbility(
        "example.com",
        "order",
        {},
        {
          host: {
            signedIn: async () => false,
            call: async () => {
              calls += 1;
              return {};
            },
          },
        },
      ),
      /ABILITY_UNKNOWN/,
    );
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        createdBy: "user",
        preconditions: { signedIn: true },
        postcondition: { ability: "search", expect: { title: "tea" } },
        ways: [{ kind: "api", operation: "order" }],
      }),
    );
    await assert.rejects(
      runAbility(
        "example.com",
        "order",
        {},
        {
          host: {
            signedIn: async () => false,
            call: async () => {
              calls += 1;
              return {};
            },
          },
        },
      ),
      /ABILITY_PRECONDITION/,
    );
    assert.equal(calls, 0);
    const applied = await runAbility(
      "example.com",
      "order",
      {},
      { host: { signedIn: async () => true, call: async () => ({ ok: true }) } },
    );
    assert.equal(applied.readBack.ok, true);
  });
});

test("capabilities list lookups and changes apart", async () => {
  await withHome(async () => {
    await saveAbility(ability({ name: "search", description: "Find" }));
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        description: "Place",
        inputs: {},
        createdBy: "user",
        ways: [{ kind: "api", operation: "order" }],
      }),
    );
    const caps = await siteCapabilities("example.com");
    assert.deepEqual(
      caps.lookups.map((item) => item.name),
      ["search"],
    );
    assert.equal(caps.lookups[0].group, "lookup");
    assert.deepEqual(
      caps.changes.map((item) => item.name),
      ["order"],
    );
    assert.equal(caps.changes[0].group, "change");
    assert.deepEqual(
      caps.abilities.map((item) => item.does),
      ["read", "write"],
    );
  });
});
