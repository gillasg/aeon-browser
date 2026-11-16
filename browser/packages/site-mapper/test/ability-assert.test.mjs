import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, runAbility, saveAbility } from "../dist/abilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-assert-"));
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

const fallback = { kind: "page", collect: { row: "body", fields: {} } };
const recorded = { items: [{ id: "a", price: "12.50" }], next: "p2" };
const good = async () => ({ items: [{ id: "b", price: "3.00" }] });

function ability(ways) {
  const now = new Date().toISOString();
  return {
    name: "feed",
    site: "example.com",
    kind: "read",
    inputs: {},
    ways,
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("a saved answer's rows, values and pattern are checked on every run", async () => {
  await withHome(async () => {
    const saved = await saveAbility(ability([{ kind: "api", operation: "feed" }, fallback]), {
      sample: { inputs: {}, result: recorded },
    });
    const asserts = saved.ability.options.asserts;
    assert.ok(Array.isArray(asserts) && asserts.length > 0, "save derived result checks");
    assert.ok(asserts.some((item) => item.op === "array_min_len" && item.path === "/items"));
    assert.ok(asserts.some((item) => item.op === "not_null" && item.path === "/items/*/price"));
    assert.ok(asserts.some((item) => item.op === "matches" && item.path === "/items/*/price"));
    assert.equal(
      asserts.some((item) => item.path === "/next" || item.path.endsWith("/next")),
      false,
      "a sibling of the list, such as a next page, is not required",
    );

    const empty = await runOnce(async () => ({ items: [] }));
    assert.equal(empty.via, "page");
    assert.equal(empty.result.items[0].id, "b");
    assert.match(empty.tried[0].error, /empty/);
    assert.match(empty.tried[0].error, /Next:/);
    assert.equal(
      empty.unverified,
      undefined,
      "an empty list is a failed way, not an unverified success",
    );

    const missing = await runOnce(async () => ({ items: [{ id: "a", price: null }] }));
    assert.equal(missing.via, "page");
    assert.match(missing.tried[0].error, /null/);
    assert.match(missing.tried[0].error, /Next:/);

    const retitled = await runOnce(async () => ({ items: [{ id: "a", price: "Call us" }] }));
    assert.equal(retitled.via, "page");
    assert.match(retitled.tried[0].error, /match/);
    assert.match(retitled.tried[0].error, /Next:/);

    const kept = await runOnce(async () => ({ items: [{ id: "c", price: "4" }] }));
    assert.equal(kept.via, "api");
    assert.equal(kept.result.items[0].id, "c");
  });
});

async function runOnce(call) {
  await saveAbility(ability([{ kind: "api", operation: "feed" }, fallback]), {
    sample: { inputs: {}, result: recorded },
  });
  return runAbility("example.com", "feed", {}, { host: { call, collect: good } });
}

test("an empty list with no other way is a failure that names the next step", async () => {
  await withHome(async () => {
    await saveAbility(ability([{ kind: "api", operation: "feed" }]), {
      sample: { inputs: {}, result: recorded },
    });
    await assert.rejects(
      runAbility("example.com", "feed", {}, { host: { call: async () => ({ items: [] }) } }),
      /RESULT_MISMATCH:[\s\S]*empty[\s\S]*Next:/,
    );
    assert.ok(await readAbility("example.com", "feed"), "the ability stays saved");
  });
});

test("a matches pattern that would catch a stored secret or is too long is not saved", async () => {
  await withHome(async () => {
    const now = new Date().toISOString();
    const secret = "secret-token-value";
    const saved = await saveAbility(
      {
        ...ability([{ kind: "api", operation: "feed" }]),
        options: {
          asserts: [
            { path: "/token", op: "matches", value: secret },
            { path: "/id", op: "matches", value: "a".repeat(501) },
            { path: "/items", op: "array_min_len", value: 1 },
          ],
        },
        createdBy: "agent",
        createdAt: now,
        updatedAt: now,
      },
      { sample: { inputs: {}, result: { token: secret, items: [{ id: "a" }] } } },
    );
    const text = JSON.stringify(saved.ability.options.asserts ?? []);
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("a".repeat(501)), false);
    assert.match(text, /array_min_len/);
  });
});

test("a matches pattern that runs too long fails the way instead of hanging", async () => {
  const { resultMismatch } = await import("../dist/ability-assert.js");
  const ability = {
    name: "feed",
    site: "example.com",
    ways: [{ kind: "api", operation: "feed" }],
    options: { asserts: [{ path: "/price", op: "matches", value: "(a+)+$" }] },
  };
  const way = ability.ways[0];
  const why = resultMismatch(ability, way, { price: `${"a".repeat(28)}!` });
  assert.match(why ?? "", /too long|budget|did not match/);
});
