import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, runAbility, saveAbility } from "../dist/abilities.js";
import { inferAbilityInputs } from "../dist/ability-infer.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-infer-"));
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
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: { type: "object", properties: {} },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("a typed value becomes an input with an example and is templated in the step", () => {
  const inferred = inferAbilityInputs(
    base({
      inputs: { type: "object", properties: {} },
      ways: [
        {
          kind: "steps",
          steps: [
            { kind: "fill", target: { role: "textbox", name: "Search" }, args: ["red shoes"] },
            { kind: "click", target: { role: "button", name: "Search" } },
          ],
        },
      ],
    }),
    { typed: [{ field: "Search terms", value: "red shoes" }] },
  );
  assert.deepEqual(inferred.inputs, ["searchTerms"]);
  const property = inferred.ability.inputs.properties.searchTerms;
  assert.equal(property.example, "red shoes");
  assert.equal(property["x-from"], "typed");
  assert.equal(inferred.ability.ways[0].steps[0].args[0], "{{inputs.searchTerms}}");
});

test("a value a later step took from an earlier answer becomes a steps reference", async () => {
  await withHome(async () => {
    const way = {
      kind: "api",
      operations: [
        { operation: "search", params: { q: "{{inputs.q}}" } },
        { operation: "detail", params: { id: "p-1005" } },
      ],
    };
    const saved = await saveAbility(
      base({ inputs: { type: "object", properties: { q: { type: "string" } } }, ways: [way] }),
      {
        demonstration: {
          inputs: { q: "tea" },
          responses: [{ hits: [{ id: "p-1005", name: "Reds" }] }, { item: { id: "p-1005" } }],
        },
      },
    );
    assert.deepEqual(saved.inferred.references, ["steps.0.hits.0.id"]);
    const stored = await readAbility("example.com", "search");
    assert.equal(stored.ways[0].operations[1].params.id, "{{steps.0.hits.0.id}}");
    assert.deepEqual(stored.ways[0].refs, [{ step: 1, param: "id", from: "steps.0.hits.0.id" }]);
    assert.equal(stored.ways[0].operations[1].params.q, undefined);

    const calls = [];
    const host = {
      call: async (operation, params) => {
        calls.push({ operation, params });
        return operation === "search" ? { hits: [{ id: "p-7" }] } : { ok: true };
      },
    };
    await runAbility("example.com", "search", { q: "tea" }, { host });
    assert.deepEqual(calls[0].params, { q: "tea" });
    assert.deepEqual(calls[1].params, { id: "p-7" }, "the reference is read at run time");
  });
});

test("a page-query value becomes an input and stays a template in the URL", async () => {
  await withHome(async () => {
    await saveAbility(
      base({
        inputs: {
          type: "object",
          properties: { q: { type: "string", example: "coffee" } },
        },
        ways: [
          {
            kind: "page",
            collect: { row: "body", fields: {} },
            url: "https://example.com/search?q=tea&page=2",
          },
        ],
      }),
      { demonstration: { inputs: { q: "tea" } } },
    );
    const stored = await readAbility("example.com", "search");
    assert.equal(stored.ways[0].url, "https://example.com/search?q={{inputs.q}}&page=2");
    assert.equal(stored.inputs.properties.q2, undefined, "the declared q is reused");
    assert.equal(stored.inputs.properties.q.example, "coffee", "an existing example stays");
  });
});

test("a value under three characters is left alone", () => {
  const inferred = inferAbilityInputs(
    base({
      inputs: { type: "object", properties: {} },
      ways: [{ kind: "steps", steps: [{ kind: "fill", target: { name: "Qty" }, args: ["2"] }] }],
    }),
    { typed: [{ field: "Quantity", value: "2" }] },
  );
  assert.deepEqual(inferred.inputs, []);
  assert.equal(inferred.ability.ways[0].steps[0].args[0], "2");
});

test("a run fills a declared input's example", async () => {
  await withHome(async () => {
    const saved = await saveAbility(
      base({ inputs: { type: "object", properties: { q: { type: "string" } } } }),
      { sample: { inputs: { q: "lamps" } } },
    );
    assert.equal(saved.ability.inputs.properties.q.example, "lamps");
    assert.equal(saved.ability.inputs.properties.q["x-from"], "run");
  });
});

test("a secret field is never inferred as an input", () => {
  const inferred = inferAbilityInputs(
    base({
      inputs: { type: "object", properties: {} },
      ways: [
        {
          kind: "steps",
          steps: [
            { kind: "fill", target: { role: "textbox", name: "Password" }, args: ["hunter2000"] },
          ],
        },
      ],
    }),
    { typed: [{ field: "Password", value: "hunter2000" }] },
  );
  assert.deepEqual(inferred.inputs, []);
  assert.equal(inferred.ability.ways[0].steps[0].args[0], "hunter2000");
});

test("a value that looks minted becomes an input without a stored example", () => {
  const token = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1x";
  const inferred = inferAbilityInputs(
    base({
      inputs: { type: "object", properties: {} },
      ways: [
        { kind: "steps", steps: [{ kind: "fill", target: { name: "Coupon" }, args: [token] }] },
      ],
    }),
    { typed: [{ field: "Coupon", value: token }] },
  );
  assert.deepEqual(inferred.inputs, ["coupon"]);
  assert.equal(inferred.ability.inputs.properties.coupon.example, undefined);
  assert.match(inferred.ability.inputs.properties.coupon.description, /not stored/);
});

test("a typed value that also appears in an answer stays an input", () => {
  const inferred = inferAbilityInputs(
    base({
      inputs: { type: "object", properties: {} },
      ways: [
        {
          kind: "api",
          operations: [
            { operation: "search", params: { q: "{{inputs.q}}" } },
            { operation: "detail", params: { id: "tea-1005" } },
          ],
        },
      ],
    }),
    {
      typed: [{ field: "Item", value: "tea-1005" }],
      responses: [{ hits: [{ id: "tea-1005" }] }, {}],
    },
  );
  assert.deepEqual(inferred.inputs, ["item"]);
  assert.equal(inferred.ability.ways[0].operations[1].params.id, "{{inputs.item}}");
  assert.deepEqual(inferred.references, []);
});
