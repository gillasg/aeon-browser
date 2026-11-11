import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  actRoute,
  combine,
  compileRoute,
  inferSlots,
  listRoutes,
  matchSavedRoute,
  promoteRoute,
  readSiteFacts,
  rememberRun,
  reportWrong,
  runAbility,
  saveAbility,
  saveActRoute,
  settleRoutes,
  stageRun,
  testAllAbilities,
} from "../dist/index.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "routes-"));
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

function steps(year) {
  return [
    {
      id: "open-list",
      kind: "click",
      target: { role: "link", name: "Orders" },
      effect: "confirmed",
      url: "https://shop.test/account",
    },
    {
      id: "year",
      kind: "fill",
      target: { role: "textbox", name: "Year", css: "#year" },
      args: [year],
      effect: "confirmed",
      pageType: "orders",
      write: false,
    },
    {
      id: "land",
      kind: "navigate",
      url: `https://shop.test/orders/${year}`,
      evidence: {
        navigated: `https://shop.test/orders/${year}`,
        request: { method: "GET", path: "/orders", status: 200 },
      },
      effect: "confirmed",
      pageType: "orders",
    },
  ];
}

test("a later prompt matches the route and takes the new number", () => {
  const compiled = compileRoute({
    site: "shop.test",
    prompt: "orders for 2024",
    steps: steps("2024"),
  });
  assert.equal(compiled.ok, true);
  const hit = matchSavedRoute("orders for 2025", [compiled.route]);
  assert.equal(hit.inputs.value, "2025");
  assert.equal(matchSavedRoute("unrelated weather", [compiled.route]), undefined);
});

test("a prompt value in a step becomes a slot, and two values in one arg do not", () => {
  const one = inferSlots("orders for 2024", steps("2024"));
  assert.equal(one.ambiguous, false);
  assert.equal(one.inputs[0].name, "value");
  assert.equal(one.inputs[0].example, "2024");
  assert.ok(one.steps.some((step) => (step.args ?? []).includes("{value}")));
  const two = inferSlots("orders for 2024 or 2025", [
    {
      ...steps("2024")[1],
      args: ["2024 and 2025"],
      target: { role: "textbox", name: "Year 2024", css: "#year" },
    },
  ]);
  assert.equal(two.ambiguous, true);
  assert.deepEqual(two.inputs, []);
  assert.equal(JSON.stringify(two.steps).includes("2024"), false);
  assert.equal(JSON.stringify(two.steps).includes("2025"), false);
  assert.ok((two.steps[0].args ?? []).includes("{value}"));
  assert.equal(two.steps[0].target.name.includes("2024"), false);
});

test("a secret is a slot with no stored value", () => {
  const slotted = inferSlots("sign in", [
    {
      id: "pw",
      kind: "fill",
      sensitive: true,
      target: { role: "textbox", name: "Password" },
      args: ["s3cret-value-not-stored"],
      effect: "confirmed",
    },
  ]);
  assert.equal(slotted.inputs[0].example, "");
  assert.equal(slotted.steps[0].args[0], "{secret}");
});

test("a route keeps every recorded step", () => {
  const compiled = compileRoute({
    site: "shop.test",
    prompt: "orders for 2024",
    steps: steps("2024"),
  });
  assert.equal(compiled.ok, true);
  assert.deepEqual(
    compiled.route.steps.map((step) => step.kind),
    ["click", "fill", "navigate"],
  );
  assert.ok(compiled.route.steps.some((step) => (step.args ?? []).includes("{value}")));
});

test("a correction never becomes a route and is stored as a quirk", async () => {
  await withHome(async () => {
    const blocked = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: steps("2024"),
      corrected: true,
    });
    assert.equal(blocked.status, "blocked");
    const later = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: steps("2024"),
    });
    assert.equal(later.status, "blocked");
    const facts = await readSiteFacts("shop.test");
    assert.ok(facts.some((fact) => fact.kind === "quirk" && fact.value.startsWith("corrected:")));
  });
});

test("two successes with different inputs promote, and Wrong drops the route", async () => {
  await withHome(async () => {
    const now = new Date("2026-11-03T00:00:00Z");
    await stageRun({ site: "shop.test", prompt: "orders for 2024", steps: steps("2024"), now });
    await stageRun({ site: "shop.test", prompt: "orders for 2025", steps: steps("2025"), now });
    await settleRoutes("shop.test", new Date(now.getTime() + 4 * 60 * 1000));
    const [route] = await listRoutes("shop.test", now);
    assert.equal(route.okRuns, 2);
    const promoted = await promoteRoute(route);
    assert.equal(promoted.learned.site, "shop.test");
    assert.equal(promoted.ability.ways[0].kind, "steps");
    assert.equal(promoted.ability.preconditions, undefined);
    const wrong = await reportWrong({
      site: "shop.test",
      routeId: route.id,
      abilityId: promoted.learned.abilityId,
      pageType: "orders",
      quirk: "Download does nothing; use the menu",
    });
    assert.equal(wrong.droppedRoute, true);
    assert.equal(wrong.stale, true);
    assert.equal((await listRoutes("shop.test", now)).length, 0);
  });
});

test("again promotes on the first run, and a cross-origin note is dropped", async () => {
  await withHome(async () => {
    const now = new Date("2026-11-03T00:00:00Z");
    await stageRun({
      site: "shop.test",
      prompt: "do it again for 2024",
      steps: steps("2024"),
      now,
    });
    await settleRoutes("shop.test", new Date(now.getTime() + 4 * 60 * 1000));
    const [route] = await listRoutes("shop.test", now);
    const promoted = await promoteRoute(route, { prompt: "do it again" });
    assert.ok(promoted.learned.name);
    const saved = await rememberRun("shop.test", {
      pages: [
        {
          url: "https://shop.test/orders/9",
          landmarks: ["main"],
          headings: ["Orders"],
          controls: ["Download"],
        },
        {
          url: "https://evil.test/orders/1",
          landmarks: ["main"],
          headings: ["Orders"],
          controls: ["Download"],
        },
      ],
      controls: [{ role: "button", name: "Download", css: ".dl", text: "Download" }],
      quirks: [{ key: "orders", value: "the export menu is under the title" }],
      pace: "1 request per second",
    });
    assert.ok(saved > 0);
    const facts = await readSiteFacts("shop.test");
    assert.equal(
      facts.some((fact) => fact.value.includes("evil.test")),
      false,
    );
    assert.ok(facts.some((fact) => fact.kind === "page"));
    assert.ok(facts.some((fact) => fact.kind === "control"));
    assert.ok(facts.some((fact) => fact.kind === "quirk"));
    assert.ok(facts.some((fact) => fact.kind === "pace"));
    assert.equal(
      facts.some((fact) => fact.kind === "shape" || fact.kind === "operation"),
      false,
    );
  });
});

test("Wrong on a pending route blocks that path", async () => {
  await withHome(async () => {
    const now = new Date("2026-11-03T00:00:00Z");
    const staged = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: steps("2024"),
      now,
    });
    assert.equal(staged.status, "pending");
    const wrong = await reportWrong({
      site: "shop.test",
      routeId: staged.route.id,
      quirk: "that was the wrong page",
    });
    assert.equal(wrong.droppedRoute, true);
    await settleRoutes("shop.test", new Date(now.getTime() + 4 * 60 * 1000));
    assert.equal((await listRoutes("shop.test", now)).length, 0);
    const again = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: steps("2024"),
      now,
    });
    assert.equal(again.status, "blocked");
  });
});

test("combine adds both success counts", () => {
  const compiled = compileRoute({
    site: "shop.test",
    prompt: "orders for 2024",
    steps: steps("2024"),
  });
  assert.equal(compiled.ok, true);
  const merged = combine(
    { ...compiled.route, okRuns: 2 },
    { ...compiled.route, okRuns: 4, id: "other" },
  );
  assert.equal(merged.okRuns, 6);
  assert.equal(merged.id, compiled.route.id);
});

test("overlapping stage and block both persist", async () => {
  await withHome(async () => {
    const now = new Date("2026-11-03T00:00:00Z");
    const results = await Promise.all([
      stageRun({
        site: "shop.test",
        prompt: "orders for 2024",
        steps: steps("2024"),
        corrected: true,
        now,
      }),
      ...[1, 2, 3, 4, 5].map((index) =>
        stageRun({
          site: "shop.test",
          prompt: `list ${index} for 2024`,
          steps: namedSteps(String(index)),
          now,
        }),
      ),
    ]);
    assert.equal(results[0].status, "blocked");
    assert.ok(results.slice(1).every((result) => result.status === "pending"));
    const again = await stageRun({
      site: "shop.test",
      prompt: "orders for 2024",
      steps: steps("2024"),
      now,
    });
    assert.equal(again.status, "blocked");
    await settleRoutes("shop.test", new Date(now.getTime() + 4 * 60 * 1000));
    assert.equal((await listRoutes("shop.test", now)).length, 5);
  });
});

function namedSteps(name) {
  return steps("2024").map((step) => ({
    ...step,
    id: `${step.id}-${name}`,
    target: step.target ? { ...step.target, name: `${step.target.name} ${name}` } : step.target,
  }));
}

test("an act route stores typed text as an empty slot", async () => {
  await withHome(async () => {
    const acted = [
      {
        role: "textbox",
        name: "Email",
        method: "fill",
        args: ["me@private.test"],
        description: "email",
      },
      {
        role: "textbox",
        name: "Password",
        method: "fill",
        args: ["s3cret-value"],
        description: "pw",
      },
      { role: "button", name: "Go", method: "press", args: ["Enter"], description: "submit" },
    ];
    const route = actRoute("shop.test", "sign in", acted);
    await saveActRoute(process.env.SITE_TO_API_HOME, "sign-in", "shop.test", "sign in", acted);
    const text = await readFile(join(process.env.SITE_TO_API_HOME, "act-routes.json"), "utf8");
    assert.equal(text.includes("me@private.test"), false);
    assert.equal(text.includes("s3cret-value"), false);
    assert.match(text, /Enter/);
    assert.ok(route.inputs.every((input) => input.example === ""));
    assert.ok(route.steps.some((step) => (step.args ?? []).includes("{value}")));
    assert.ok(route.steps.some((step) => (step.args ?? []).includes("{secret}")));
  });
});

test("a subdomain is dropped and query values are not stored", async () => {
  await withHome(async () => {
    await rememberRun("shop.test", {
      pages: [
        {
          url: "https://cdn.shop.test/assets/app.js",
          landmarks: ["main"],
          headings: ["CDN"],
          controls: ["Load"],
        },
        {
          url: "https://www.shop.test/orders?code=abc123secret&token=tok-value",
          landmarks: ["main"],
          headings: ["Orders"],
          controls: ["Download"],
        },
      ],
    });
    const text = JSON.stringify(await readSiteFacts("shop.test"));
    assert.equal(text.includes("cdn.shop.test"), false);
    assert.equal(text.includes("abc123secret"), false);
    assert.equal(text.includes("tok-value"), false);
    assert.match(text, /code/);
    assert.match(text, /token/);
    assert.match(text, /orders/);
  });
});

test("replay stops before a step whose page or control changed", async () => {
  await withHome(async () => {
    const pageActs = [];
    let pages = 0;
    await saveAbility(stepsAbility("page-guard", replaySteps()));
    await assert.rejects(
      runAbility(
        "shop.test",
        "page-guard",
        {},
        { host: pageHost(pageActs, () => (pages++ === 0 ? "orders" : "checkout")) },
      ),
      /page type checkout is not orders/,
    );
    assert.deepEqual(pageActs, ["click"]);

    const controlActs = [];
    let seen = 0;
    await saveAbility(stepsAbility("control-guard", replaySteps()));
    await assert.rejects(
      runAbility(
        "shop.test",
        "control-guard",
        {},
        {
          host: {
            pageType: async () => "orders",
            controls: async () => {
              seen += 1;
              return seen === 1
                ? [{ role: "button", name: "Save", css: "#go" }]
                : [{ role: "button", name: "Cancel", css: "#go" }];
            },
            act: async (step) => {
              controlActs.push(step.kind);
              return {};
            },
          },
        },
      ),
      /target did not resolve/,
    );
    assert.deepEqual(controlActs, ["click"]);
  });
});

function replaySteps() {
  return [
    { kind: "click", onPageType: "orders", target: { role: "button", name: "Save", css: "#go" } },
    { kind: "click", onPageType: "orders", target: { role: "button", name: "Save", css: "#go" } },
  ];
}

function pageHost(acted, pageType) {
  return {
    pageType,
    controls: async () => [{ role: "button", name: "Save", css: "#go" }],
    act: async (step) => {
      acted.push(step.kind);
      return {};
    },
  };
}

function stepsAbility(name, saved) {
  const now = new Date().toISOString();
  return {
    name,
    site: "shop.test",
    kind: "read",
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    ways: [{ kind: "steps", steps: saved }],
    tests: [],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("dry tests stay offline", async () => {
  await withHome(async () => {
    await saveAbility(ordersAbility());
    const rows = await testAllAbilities({ dry: true, sites: ["shop.test"] });
    const orders = rows.find((row) => row.name === "orders");
    assert.equal(orders.ok, true);
    assert.equal(orders.skipped, undefined);
  });
});

test("a result missing a schema field fails that way and queues a heal", async () => {
  await withHome(async () => {
    await saveAbility(ordersAbility());
    await assert.rejects(
      runAbility(
        "shop.test",
        "orders",
        { year: "2024" },
        { host: { call: async () => ({ year: "2024" }) } },
      ),
      /missing id/,
    );
    const heal = await readFile(
      join(process.env.SITE_TO_API_HOME, "sites/shop.test/heal.jsonl"),
      "utf8",
    );
    assert.match(heal, /missing id/);
  });
});

function ordersAbility() {
  return {
    name: "orders",
    site: "shop.test",
    kind: "read",
    inputs: { type: "object", properties: { year: { type: "string" } } },
    outputs: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    ways: [{ kind: "api", operation: "orders", params: { year: "{{inputs.year}}" } }],
    tests: [
      { inputs: { year: "2024" }, expect: { id: "a" } },
      { inputs: { year: "2025" }, expect: { id: "b" } },
    ],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
