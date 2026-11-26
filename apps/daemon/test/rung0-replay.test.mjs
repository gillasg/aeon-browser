import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openChatStore } from "@aeon/store";
import { readHealLog, saveAbility, siteDir } from "@browserkit/site-mapper";
import { AbilityIdleWorker, abilityOperations, cellBridge } from "../dist/ability-idle-worker.js";
import { rung0Card, rung0Eligible, rung0Sites, tryRung0 } from "../dist/rung0-replay.js";
import { ChatService, closeProjectServices } from "./chat-service-fixture.mjs";
import { FakePiPort } from "./fake-pi-port.mjs";

function route(overrides = {}) {
  return {
    id: "r1",
    site: "shop.test",
    signature: ["orders", "shop", "test"],
    inputs: [{ name: "year", example: "2025" }],
    trigger: "orders on shop.test for 2025",
    inputHistory: [{ year: "2024" }, { year: "2025" }],
    steps: [],
    reads: [],
    writes: false,
    okRuns: 2,
    lastOkAt: "2026-11-03T00:00:00Z",
    summary: "orders",
    cell: "",
    ambiguous: false,
    expiresAt: "2026-12-03T00:00:00Z",
    fingerprint: "f",
    abilityId: "shop.test/orders",
    ...overrides,
  };
}

function ability(overrides = {}) {
  return {
    name: "orders",
    site: "shop.test",
    kind: "read",
    inputs: { type: "object", properties: { year: { type: "string" } } },
    ways: [{ kind: "api", operation: "listOrders", params: { year: "{{inputs.year}}" } }],
    options: {},
    stats: { runs: 2, failures: 0 },
    createdBy: "agent",
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
    ...overrides,
  };
}

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    listRoutes: async () => [route()],
    readAbility: async () => ability(),
    runAbility: async (site, name, inputs) => {
      calls.push({ site, name, inputs });
      return {
        result: { result: "3 orders in 2025" },
        via: "api",
        tried: [],
        compiled: true,
        elapsedMs: 42,
        receipt: "0.04s · no model · API",
      };
    },
    ...overrides,
  };
}

test("a clean read hit runs the compiled ability with no model and returns the proof", async () => {
  const d = deps();
  const outcome = await tryRung0("orders on shop.test for 2025", {}, d);
  assert.equal(outcome.hit, true);
  assert.equal(outcome.modelTurns, 0);
  assert.equal(outcome.compiled, true);
  assert.equal(outcome.elapsedMs, 42);
  assert.equal(outcome.answer, "3 orders in 2025");
  assert.deepEqual(d.calls, [{ site: "shop.test", name: "orders", inputs: { year: "2025" } }]);
  const card = rung0Card("chat", "run", "orders on shop.test for 2025", outcome);
  assert.equal(card.kind, "run-card");
  assert.match(card.card.items[0].detail, /0 model turns · compiled API/);
  assert.deepEqual(card.card.items[1], { kind: "receipt", receipt: "speed", durationMs: 42 });
});

test("an unconfirmed write never runs at rung 0; a confirmed one may", async () => {
  const write = deps({ readAbility: async () => ability({ kind: "write" }) });
  const blocked = await tryRung0("orders on shop.test for 2025", {}, write);
  assert.deepEqual(blocked, { hit: false, reason: "unconfirmed write" });
  assert.equal(write.calls.length, 0);
  const irreversible = deps({
    readAbility: async () => ability({ effect: "irreversible", options: { rung0Confirmed: true } }),
  });
  assert.equal((await tryRung0("orders on shop.test for 2025", {}, irreversible)).hit, false);
  const confirmed = deps({
    readAbility: async () => ability({ kind: "write", options: { rung0Confirmed: true } }),
  });
  assert.equal((await tryRung0("orders on shop.test for 2025", {}, confirmed)).hit, true);
});

test("misses, doubt, errors and timeouts fall back instead of answering", async () => {
  const prompt = "orders on shop.test for 2025";
  assert.equal((await tryRung0("orders for 2025", {}, deps())).reason, "no site");
  assert.equal(
    (await tryRung0(prompt, {}, deps({ listRoutes: async () => [] }))).reason,
    "no route",
  );
  const unpromoted = deps({ listRoutes: async () => [route({ abilityId: undefined })] });
  assert.equal((await tryRung0(prompt, {}, unpromoted)).reason, "not promoted");
  const ambiguous = deps({ listRoutes: async () => [route({ ambiguous: true })] });
  assert.equal((await tryRung0(prompt, {}, ambiguous)).reason, "ambiguous slots");
  // Only the exact saved request repeats; a look-alike or a new value goes to the model.
  for (const lookAlike of [
    "orders on shop.test for 2025 and 2026",
    "orders on shop.test for 2026",
    "refunds and orders on shop.test for 2025",
  ])
    assert.equal((await tryRung0(lookAlike, {}, deps())).reason, "no route", lookAlike);
  const legacy = deps({ listRoutes: async () => [route({ trigger: undefined })] });
  assert.equal((await tryRung0(prompt, {}, legacy)).reason, "no route");
  const stepsOnly = deps({
    readAbility: async () => ability({ ways: [{ kind: "steps", steps: [] }] }),
  });
  assert.equal((await tryRung0(prompt, {}, stepsOnly)).reason, "no executable way");
  const broken = deps({
    runAbility: async () => {
      throw new Error("site down");
    },
  });
  assert.deepEqual(await tryRung0(prompt, {}, broken), { hit: false, reason: "error: site down" });
  const slow = deps({ runAbility: () => new Promise(() => undefined), timeoutMs: 20 });
  assert.equal((await tryRung0(prompt, {}, slow)).reason, "timeout");
  const empty = deps({ runAbility: async () => ({ result: [], via: "api", tried: [] }) });
  assert.equal((await tryRung0(prompt, {}, empty)).reason, "empty or unverified result");
});

test("the tab the prompt came from names the site; selections and attachments need the model", async () => {
  const page = { kind: "page", url: "https://www.shop.test/account", sourceStatus: "current" };
  assert.deepEqual(rung0Sites({ text: "x", browserContext: page }), ["shop.test"]);
  assert.equal(rung0Eligible({ text: "x", browserContext: page }), true);
  assert.equal(rung0Eligible({ text: "x", browserContext: { ...page, kind: "selection" } }), false);
  assert.equal(rung0Eligible({ text: "x", attachments: [{}] }), false);
  const local = deps({
    listRoutes: async () => [route({ signature: ["orders"], trigger: "orders for 2025" })],
  });
  const outcome = await tryRung0("orders for 2025", { sites: ["shop.test"] }, local);
  assert.equal(outcome.hit, true);
});

async function chatService(t, rung0) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "rung0-chat-"));
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => {
    closeProjectServices(dataDirectory);
    return rm(dataDirectory, { recursive: true, force: true });
  });
  const pi = new FakePiPort();
  const service = new ChatService({ dataDirectory, store, pi, rung0 });
  return { service, pi };
}

test("chat: a rung-0 hit answers without a model turn, a miss or a throw goes to Pi", async (t) => {
  const hit = await tryRung0("orders on shop.test for 2025", {}, deps());
  const fast = await chatService(t, async () => hit);
  const events = [];
  fast.service.subscribeAllEvents((chatId, event) => events.push(event));
  const draft = await fast.service.createDraft();
  await fast.service.submitPrompt(draft.chatId, "orders on shop.test for 2025");
  assert.equal(fast.pi.prompts.length, 0);
  const card = events.find((event) => event.kind === "run-card");
  assert.equal(card.card.items[0].text, "3 orders in 2025");

  const miss = await chatService(t, async () => ({ hit: false, reason: "no route" }));
  const missDraft = await miss.service.createDraft();
  await miss.service.submitPrompt(missDraft.chatId, "orders on shop.test for 2025");
  assert.deepEqual(
    miss.pi.prompts.map(({ text }) => text),
    ["orders on shop.test for 2025"],
  );

  const thrown = await chatService(t, async () => {
    throw new Error("boom");
  });
  const thrownDraft = await thrown.service.createDraft();
  await thrown.service.submitPrompt(thrownDraft.chatId, "orders on shop.test for 2025");
  assert.equal(thrown.pi.prompts.length, 1);
});

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "idle-worker-"));
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

async function mapSite(site) {
  const folder = siteDir(site);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "model.json"),
    JSON.stringify({ version: 1, site, operations: [], generatedAt: "2026-11-20T00:00:00Z" }),
  );
}

const idle = () => ({ workingChats: 0, askingChats: 0, routines: 0, cells: 0, abilities: 0 });

test("idle worker: drifted operations from health reach repair over the real cell bridge", async () => {
  await withHome(async () => {
    await mapSite("shop.test");
    await saveAbility(ability({ site: "shop.test" }));
    const folder = siteDir("shop.test");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "health.json"),
      JSON.stringify({
        site: "shop.test",
        checkedAt: "2026-11-20T00:00:00Z",
        results: [
          { id: "listOrders", status: "drift" },
          { id: "unrelated", status: "broken" },
        ],
      }),
    );
    const repaired = [];
    const cells = [];
    const worker = new AbilityIdleWorker({
      activity: idle,
      perHour: 100,
      cell: async (code) => {
        cells.push(code);
        return 1;
      },
      model: async () => ({}),
      repairOperations: async (site, operations, options) => {
        repaired.push({
          site,
          operations,
          browsers: (await (await options.bridge()).status()).browsers,
        });
        return { rerecorded: [], after: { site, checkedAt: "", results: [] } };
      },
    });
    await worker.tick();
    assert.deepEqual(repaired, [{ site: "shop.test", operations: ["listOrders"], browsers: 1 }]);
    assert.ok(cells.length >= 1, "the bridge status asks the browser");
    const events = (await readHealLog("shop.test", { name: "orders" })).map((entry) => entry.event);
    assert.equal(events[0], "attempt");
    assert.equal(events.at(-1), "unrepaired");
  });
});

test("idle worker: a read with stored cases is checked live through a host that refuses writes", async () => {
  await withHome(async () => {
    await mapSite("shop.test");
    await saveAbility(
      ability({
        ways: [{ kind: "api", operation: "listOrders" }],
        inputs: { type: "object", properties: {} },
        tests: [{ inputs: {}, expect: { result: "orders" } }],
      }),
      { check: false },
    );
    const notes = [];
    let relearned;
    const worker = new AbilityIdleWorker({
      activity: idle,
      perHour: 100,
      liveHost: () => ({ call: async () => ({ result: "nothing like it" }) }),
      relearn: async (item, failure) => {
        relearned = failure;
        return undefined;
      },
      onNote: (_item, note) => notes.push(note),
    });
    await worker.tick();
    assert.deepEqual(relearned.operations, ["listOrders"]);
    assert.match(relearned.reason, /contract: live case failed/);
    assert.equal(notes[0].repairFailed, true);
  });
});

test("cell bridge status reports an offline browser instead of a stub", async () => {
  const offline = cellBridge(async () => {
    throw new Error("BROWSER_OFFLINE");
  });
  assert.deepEqual(await offline.status(), { browsers: 0 });
  assert.deepEqual(
    abilityOperations(
      ability({ ways: [{ kind: "api", operations: [{ operation: "a" }, { operation: "b" }] }] }),
    ),
    ["a", "b"],
  );
});
