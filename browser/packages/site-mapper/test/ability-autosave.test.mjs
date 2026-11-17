import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAbilities, readAbility } from "../dist/abilities.js";
import {
  abilityNameFor,
  autoSaveAbility,
  autoSaveBlocker,
  buildAutoAbility,
  findDuplicate,
  inferScriptInputs,
} from "../dist/ability-autosave.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-autosave-"));
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

function run(overrides = {}) {
  return {
    site: "shop.example",
    request: "download my October receipts",
    code: [
      "const month = 'October';",
      "await page.goto('https://shop.example/receipts?month=October');",
      "return await page.read();",
    ].join("\n"),
    result: { ok: true, month: "October" },
    ok: true,
    at: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

test("a month in the request becomes a caller input templated into the script", () => {
  const inferred = inferScriptInputs(run().request, run().code);
  assert.deepEqual(
    inferred.inputs.map((value) => value.name),
    ["month"],
  );
  assert.equal(inferred.inputs[0].example, "October");
  assert.equal(inferred.properties.month.example, "October");
  assert.match(inferred.code, /inputs\.month/);
  assert.doesNotMatch(inferred.code, /'October'/);
  assert.doesNotMatch(inferred.code, /month=October/);
});

test("a search term, a year and a typed value become inputs; a credential never does", () => {
  const request = 'find "blue mug" orders from 2026 for order 12345 token ABCDEF1234567890abcdefgh';
  const code = [
    "await page.fill('input', 'blue mug');",
    "await page.goto('https://shop.example/orders?year=2026');",
    "await page.fill('#order', '12345');",
    "await page.fill('#email', 'alice@example.com');",
    "return await page.read();",
  ].join("\n");
  const inferred = inferScriptInputs(request, code, [{ field: "Order", value: "12345" }]);
  const names = inferred.inputs.map((value) => value.name);
  assert.ok(names.includes("blueMug"), names.join(","));
  assert.ok(names.includes("year"), names.join(","));
  assert.ok(names.includes("order"), names.join(","));
  assert.ok(!names.some((name) => /token|abcdef/i.test(name)), names.join(","));
  assert.ok(!inferred.code.includes("ABCDEFGH"));
});

test("a run that failed, was corrected or was a one-off is not saved", () => {
  assert.match(autoSaveBlocker(run({ ok: false })) ?? "", /successfully/);
  assert.match(autoSaveBlocker(run({ corrected: true })) ?? "", /corrected/);
  assert.match(autoSaveBlocker(run({ oneOff: true })) ?? "", /one-off/);
  assert.match(autoSaveBlocker(run({ code: "" })) ?? "", /browser_code/);
  assert.equal(autoSaveBlocker(run()), undefined);
});

test("the build produces a page script way with caller inputs", () => {
  const ability = buildAutoAbility(run());
  assert.equal(ability.site, "shop.example");
  assert.equal(ability.kind, "read");
  assert.equal(ability.ways[0].kind, "script");
  assert.equal(ability.ways[0].runtime, "page");
  assert.match(ability.ways[0].code, /inputs\.month/);
  assert.equal(ability.inputs.properties.month.example, "October");
  assert.equal(abilityNameFor("download my October receipts"), "october-receipts");
});

test("a script way already on the site is treated as a duplicate to update, not a new ability", async () => {
  await withHome(async () => {
    const first = run();
    const saved = await autoSaveAbility(first);
    assert.equal(saved.status, "saved");
    const stored = await readAbility("shop.example", "october-receipts");
    assert.ok(stored);
    const again = await autoSaveAbility(run({ result: undefined }));
    assert.equal(again.status, "updated");
    assert.equal(again.ability?.name, "october-receipts");
    assert.equal(
      (await listAbilities("shop.example")).filter((a) => a.createdBy !== "builtin").length,
      1,
    );
    assert.deepEqual(findDuplicate([stored], buildAutoAbility(run()))?.name, "october-receipts");
  });
});

test("a save records the first run's result as a test and returns one short run-card line", async () => {
  await withHome(async () => {
    const outcome = await autoSaveAbility(run());
    assert.equal(outcome.status, "saved");
    assert.equal(outcome.line, "Learned: october-receipts [Rename] [Forget]");
    const stored = await readAbility("shop.example", "october-receipts");
    assert.equal(stored.tests.length, 1);
    assert.equal(stored.tests[0].expect.ok, true);
  });
});
