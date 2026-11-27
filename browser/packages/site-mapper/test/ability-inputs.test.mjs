import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAbility, saveAbility } from "../dist/abilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-inputs-"));
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

function ability() {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: {
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "number" } },
    },
    ways: [
      {
        kind: "api",
        operation: "search",
        params: { q: "{{inputs.q}}", limit: "{{inputs.limit}}" },
      },
    ],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("an input the ability does not declare is rejected and the declared names are listed", async () => {
  await withHome(async () => {
    await saveAbility(ability());
    const host = { call: async () => ({ items: [{ id: "a" }] }) };
    await assert.rejects(runAbility("example.com", "search", { lmit: 2 }, { host }), (error) => {
      assert.match(error.message, /Unknown input "lmit"/);
      assert.match(error.message, /Declared: q, limit/);
      assert.match(error.message, /Did you mean "limit"/);
      return true;
    });
    const run = await runAbility("example.com", "search", { q: "tea", limit: 2 }, { host });
    assert.equal(run.via, "api");
  });
});

function cartWrite(ways) {
  const now = new Date().toISOString();
  return {
    name: "add",
    site: "shop.example",
    kind: "write",
    inputs: {
      type: "object",
      properties: { qty: { type: "number" }, size: { type: "string", enum: ["S", "L"] } },
      required: ["qty"],
    },
    ways,
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

const CLICK_WAY = {
  kind: "steps",
  steps: [
    { kind: "fill", target: { role: "textbox", name: "Quantity" }, args: ["{qty}"] },
    { kind: "click", target: { role: "button", name: "Add to cart" } },
  ],
};

function shopHost(controls, acted) {
  return {
    controls: async () => controls(),
    act: async (step) => {
      acted.push(step);
      return { ok: true };
    },
  };
}

test("required, type and enum are checked before any way runs and no key is claimed", async () => {
  await withHome(async () => {
    const acted = [];
    const page = () => [
      { role: "textbox", name: "Quantity" },
      { role: "button", name: "Add to cart" },
    ];
    await saveAbility(cartWrite([CLICK_WAY]), { replace: true });
    const host = shopHost(page, acted);
    const run = (inputs) => runAbility("shop.example", "add", inputs, { host, key: "k1" });
    await assert.rejects(run({}), /^Error: ABILITY_INPUT: qty is required \(number\)/);
    await assert.rejects(run({ qty: "many" }), /ABILITY_INPUT: qty must be number/);
    await assert.rejects(run({ qty: 1, size: "M" }), /ABILITY_INPUT: size must be one of "S", "L"/);
    assert.equal(acted.length, 0);
    // The same key still runs: nothing above claimed it. "5" becomes 5 for a number input.
    const done = await run({ qty: "5" });
    assert.equal(done.write.write_status, "applied");
    assert.deepEqual(acted[0].args, ["5"]);
  });
});

test("a renamed control replays as adapted; no match is ABILITY_DRIFT with the closest three", async () => {
  await withHome(async () => {
    await saveAbility(cartWrite([CLICK_WAY]), { replace: true });
    let button = "Add to basket";
    const acted = [];
    const host = shopHost(
      () => [
        { role: "textbox", name: "Quantity" },
        { role: "button", name: button },
        { role: "link", name: "Home" },
      ],
      acted,
    );
    const run = await runAbility("shop.example", "add", { qty: 2 }, { host, key: "a1" });
    assert.deepEqual(run.adapted, [
      {
        from: { role: "button", name: "Add to cart" },
        to: { role: "button", name: "Add to basket" },
      },
    ]);
    assert.equal(acted[1].target.name, "Add to basket");
    button = "Checkout now";
    await assert.rejects(
      runAbility("shop.example", "add", { qty: 2 }, { host, key: "a2" }),
      /ABILITY_DRIFT: no button "Add to cart" on the page now; closest: /,
    );
  });
});

test("a failure before the commit step frees the key, so the retry runs", async () => {
  await withHome(async () => {
    await saveAbility(cartWrite([CLICK_WAY]), { replace: true });
    let missing = true;
    const acted = [];
    const host = shopHost(
      () => [
        { role: "textbox", name: "Quantity" },
        ...(missing ? [] : [{ role: "button", name: "Add to cart" }]),
      ],
      acted,
    );
    const run = () => runAbility("shop.example", "add", { qty: 1 }, { host, key: "r1" });
    await assert.rejects(run(), /ABILITY_DRIFT/);
    missing = false;
    const retry = await run();
    assert.equal(retry.write.write_status, "applied");
    assert.equal(retry.write.replayed, undefined);
  });
});

test("a page script gets its inputs flat, over the way's own defaults", async () => {
  await withHome(async () => {
    const way = { kind: "script", runtime: "page", code: "return inputs;", input: { size: "S" } };
    await saveAbility(cartWrite([way]), { replace: true });
    let given;
    const host = { script: async (_code, inputs) => ((given = inputs), { ok: true }) };
    await runAbility("shop.example", "add", { qty: 3 }, { host, key: "f1" });
    assert.deepEqual(given, { size: "S", qty: 3 });
  });
});
