import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveAbility } from "../dist/abilities.js";
import { HEAL_LOG_LIMIT, appendHealLog, readHealLog } from "../dist/ability-heal.js";
import { repairAbilityWhileIdle } from "../dist/ability-idle.js";
import { abilityFromRoute } from "../dist/route-promote.js";
import { apiWayFor, runnableWays, scriptWayFor, wayProblem } from "../dist/route-runnable.js";
import { siteDir } from "../dist/registry.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "route-runnable-"));
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

function route(overrides = {}) {
  return {
    id: "r1",
    site: "shop.test",
    signature: ["orders"],
    inputs: [{ name: "year", example: "2025" }],
    inputHistory: [{ year: "2024" }, { year: "2025" }],
    steps: [
      {
        kind: "click",
        target: { role: "link", name: "Orders" },
        onPageType: "account",
        expectEffect: "confirmed",
      },
      {
        kind: "navigate",
        url: "https://shop.test/orders/{year}",
        onPageType: "orders",
        expectEffect: "confirmed",
        expectRequest: { method: "GET", path: "/api/orders/2025?sort=new" },
      },
    ],
    reads: [],
    writes: false,
    okRuns: 2,
    lastOkAt: "2026-11-03T00:00:00Z",
    summary: "orders",
    cell: "",
    ambiguous: false,
    expiresAt: "2026-12-03T00:00:00Z",
    fingerprint: "f",
    ...overrides,
  };
}

const model = {
  operations: [
    {
      id: "listOrders",
      method: "GET",
      path: "/api/orders/{year}",
      role: "read",
      kind: "rest",
      params: [
        { name: "year", in: "path", required: true, schema: { type: "integer" } },
        { name: "sort", in: "query", required: true, schema: { type: "string" } },
      ],
      dependencies: [],
      samples: [],
    },
  ],
};

test("a route whose read went through a mapped API promotes to a typed API call first", () => {
  const way = apiWayFor(route(), model);
  assert.deepEqual(way, {
    kind: "api",
    operation: "listOrders",
    params: { year: "{{inputs.year}}", sort: "new" },
  });
  const ability = abilityFromRoute(route(), model);
  assert.deepEqual(
    ability.ways.map((item) => item.kind),
    ["api", "script", "steps"],
  );
  assert.deepEqual(ability.inputs.required, ["year"]);
});

test("a slot the API cannot carry keeps the route off the API way", () => {
  const other = route({ inputs: [{ name: "status", example: "shipped" }] });
  assert.equal(apiWayFor(other, model), undefined);
});

test("without a model the route compiles to a browser script that parses and uses its slots", () => {
  const way = scriptWayFor(route());
  assert.equal(way.kind, "script");
  assert.equal(wayProblem(way, route()), undefined);
  assert.match(way.code, /page\.goto\(fill\("https:\/\/shop\.test\/orders\/\{year\}"\)\)/);
  assert.match(way.code, /getByRole\("link", \{ name: fill\("Orders"\) \}\)/);
});

test("ways that would not run are never saved", () => {
  assert.match(
    wayProblem(
      { kind: "script", runtime: "page", code: "async (page) => { await page.goto(" },
      route(),
    ),
    /does not parse/,
  );
  assert.match(
    wayProblem({ kind: "script", runtime: "page", code: 'async () => "{other}"' }, route()),
    /no input declares/,
  );
  assert.match(
    wayProblem({ kind: "api", operation: "gone" }, route(), model),
    /not in the site model/,
  );
  // An unknown step kind cannot be repeated, a secret slot is never replayed: no script at all.
  const odd = route({ steps: [{ kind: "drag", onPageType: "", expectEffect: "confirmed" }] });
  assert.equal(scriptWayFor(odd), undefined);
  const secret = route({
    steps: [
      {
        kind: "navigate",
        url: "https://shop.test/login",
        onPageType: "",
        expectEffect: "confirmed",
      },
      {
        kind: "fill",
        target: { css: "#pw" },
        args: ["{secret}"],
        onPageType: "",
        expectEffect: "confirmed",
      },
    ],
  });
  assert.equal(scriptWayFor(secret), undefined);
  // An ambiguous route keeps only its recorded steps.
  assert.deepEqual(
    abilityFromRoute(route({ ambiguous: true }), model).ways.map((item) => item.kind),
    ["steps"],
  );
  // Writes never compile to an API call.
  assert.deepEqual(
    runnableWays(route({ writes: true }), model).map((item) => item.kind),
    ["script"],
  );
});

test("heal.jsonl keeps attempts and outcomes, is bounded, and skips torn lines", async () => {
  await withHome(async () => {
    await appendHealLog("shop.test", {
      event: "attempt",
      name: "orders",
      operations: ["listOrders"],
    });
    await Promise.all(
      Array.from({ length: HEAL_LOG_LIMIT + 5 }, (_, index) =>
        appendHealLog("shop.test", { event: "drift", name: `n${index}`, reason: "shape" }),
      ),
    );
    const all = await readHealLog("shop.test");
    assert.equal(all.length, HEAL_LOG_LIMIT);
    assert.equal(all.at(-1).name, `n${HEAL_LOG_LIMIT + 4}`);
    const file = join(siteDir("shop.test"), "heal.jsonl");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, '{"torn": \n');
    assert.equal((await readHealLog("shop.test", { name: "orders" })).length, 0);
    assert.equal((await readHealLog("shop.test", { limit: 2 })).length, 2);
    assert.ok((await readFile(file, "utf8")).split("\n").length <= HEAL_LOG_LIMIT + 3);
  });
});

test("an idle repair hands the failing operations to relearn and logs the version change", async () => {
  await withHome(async () => {
    const now = "2026-11-17T10:00:00.000Z";
    const saved = await saveAbility({
      name: "orders",
      site: "shop.test",
      kind: "read",
      inputs: { type: "object", properties: {} },
      ways: [{ kind: "api", operation: "listOrders" }],
      options: {},
      stats: { runs: 1, failures: 0 },
      createdBy: "agent",
      createdAt: now,
      updatedAt: now,
    });
    let seen;
    const result = await repairAbilityWhileIdle(saved.ability, {
      check: async () => ({
        ok: false,
        reason: "contract: listOrders drift",
        operations: ["listOrders"],
      }),
      relearn: async (ability, failure) => {
        seen = failure.operations;
        return { ...ability, ways: [{ kind: "api", operation: "listOrdersV2" }] };
      },
    });
    assert.deepEqual(seen, ["listOrders"]);
    assert.equal(result.status, "repaired");
    assert.equal(result.healed.fromVersion, 1);
    assert.equal(result.healed.toVersion, 2);
    const log = await readHealLog("shop.test", { name: "orders" });
    const events = log.map((entry) => entry.event);
    assert.deepEqual(events, ["attempt", "repaired"]);
    assert.deepEqual(log[0].operations, ["listOrders"]);
    assert.equal(log[1].fromVersion, 1);
    assert.equal(log[1].toVersion, 2);
  });
});
