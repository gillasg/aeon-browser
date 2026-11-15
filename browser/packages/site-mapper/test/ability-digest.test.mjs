import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, saveAbility, testAbility } from "../dist/abilities.js";
import { normalizedCode, untestedWays } from "../dist/ability-digest.js";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-digest-"));
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

const way = (code) => ({ kind: "script", runtime: "node", code: `void inputs.q; ${code}` });
const tests = [{ inputs: { q: "tea" }, expect: { title: "tea" } }];

function ability(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    description: "Find the title",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    outputs: { type: "object", properties: { title: { type: "string" } } },
    ways: [way("return { title: 'tea' };")],
    tests,
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("comments and formatting are not content, strings are", () => {
  assert.equal(normalizedCode("return 1; // one"), "return 1;");
  assert.equal(normalizedCode("/* lead */ return 2"), "return 2");
  assert.equal(
    normalizedCode("const url = 'https://x/y'; // not a comment"),
    "const url = 'https://x/y';",
  );
  assert.notEqual(normalizedCode("return 'a b'"), normalizedCode("return 'a  b'"));
});

test("a passing save stamps the way, and a description change keeps it tested", async () => {
  await withHome(async () => {
    await saveAbility(ability(), { host: {} });
    assert.equal(untestedWays(await readAbility("example.com", "search")).length, 0);
    await saveAbility(ability({ description: "Find a product title" }));
    const stored = await readAbility("example.com", "search");
    assert.equal(untestedWays(stored).length, 0);
    assert.equal(stored.tested[Object.keys(stored.tested)[0]].ok, true);
  });
});

test("a semantic edit marks the way untested while a comment-only edit does not", async () => {
  await withHome(async () => {
    await saveAbility(ability(), { host: {} });
    await saveAbility(ability({ ways: [way("return { title: 'tea' }; // the same result")] }));
    assert.equal(untestedWays(await readAbility("example.com", "search")).length, 0);
    await saveAbility(ability({ ways: [way("return { title: 'coffee' };")] }));
    const changed = await readAbility("example.com", "search");
    assert.equal(untestedWays(changed).length, 1);
    assert.equal((await siteCapabilities("example.com")).lookups[0].untested, true);
  });
});

test("a changed test case also makes the way untested", async () => {
  await withHome(async () => {
    await saveAbility(ability(), { host: {} });
    await saveAbility(
      ability({ tests: [{ inputs: { q: "coffee" }, expect: { title: "coffee" } }] }),
    );
    assert.equal(untestedWays(await readAbility("example.com", "search")).length, 1);
  });
});

test("an unchanged save does not run the cases again", async () => {
  await withHome(async () => {
    const api = { kind: "api", operation: "search", params: { q: "{{inputs.q}}" } };
    const apiAbility = (overrides = {}) => ability({ ways: [api], ...overrides });
    let calls = 0;
    const host = {
      call: async () => {
        calls += 1;
        return { title: "tea" };
      },
    };
    await saveAbility(apiAbility(), { host });
    assert.equal(calls, 1);
    const again = await saveAbility(apiAbility(), { host });
    assert.equal(again.tests.skipped, true);
    assert.equal(calls, 1, "the stored pass is still current");
  });
});

test("testAbility records its result, and a failure shows as untested", async () => {
  await withHome(async () => {
    await saveAbility(ability());
    assert.equal(untestedWays(await readAbility("example.com", "search")).length, 1);
    const passed = await testAbility("example.com", "search", { host: {} });
    assert.equal(passed.ok, true);
    assert.equal(untestedWays(await readAbility("example.com", "search")).length, 0);

    await saveAbility(
      ability({ tests: [{ inputs: { q: "coffee" }, expect: { title: "coffee" } }] }),
    );
    const failed = await testAbility("example.com", "search", { host: {} });
    assert.equal(failed.ok, false);
    assert.equal(untestedWays(await readAbility("example.com", "search")).length, 1);
  });
});
