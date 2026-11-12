import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAeonModelRuntime, createLiveModels } from "../dist/index.js";

const SECRET = "sk-live-models-test-secret-never-log";
const NEW_MODEL = "test-live-only";

function catalog(model = {}) {
  return {
    object: "list",
    data: [
      {
        id: "deepseek-v4.1-flash",
        name: "A name the live list must not win with",
        type: "chat",
        limit: { context: 7, output: 7 },
        cost: { text: { input: { price: 9 }, output: { price: 9 } } },
        api: { "chat-completions": {} },
        modalities: { input: ["text"] },
      },
      {
        id: NEW_MODEL,
        name: "Test Live Only",
        type: "chat",
        limit: { context: 123_456, output: 4_096 },
        cost: {
          text: { input: { price: 0.5, cache: { read: 0.05 } }, output: { price: 2 } },
        },
        capabilities: { reasoning: { supported: true, effort: ["low", "high"] } },
        modalities: { input: ["text", "image/png"] },
        api: { "chat-completions": {} },
        ...model,
      },
    ],
  };
}

/** Only the fields the catalog reader uses, so the test needs no Response global. */
function respond(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function denied() {
  return { ok: false, status: 401, json: async () => ({}) };
}

function credentialStore(key = SECRET) {
  const current = { type: "api_key", key };
  return {
    read: async () => current,
    list: async () => [{ providerId: "opencode-go", type: "api_key" }],
    modify: async (_providerId, fn) => fn(current),
    delete: async () => undefined,
  };
}

async function withAgentDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-live-models-"));
  await writeFile(
    join(directory, "auth.json"),
    JSON.stringify({ "opencode-go": { type: "api_key", key: SECRET } }),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("live models are merged over the built-in catalog and built-in metadata wins", async () => {
  const models = createLiveModels({
    credentials: credentialStore(),
    modelsStore: new InMemoryModelsStore(),
    fetch: async () => respond(catalog()),
  });
  await models.refresh();
  const list = models.models.getModels("opencode-go");

  const builtin = list.find((model) => model.id === "deepseek-v4.1-flash");
  assert.ok(builtin);
  assert.notEqual(builtin.name, "A name the live list must not win with");
  assert.notEqual(builtin.contextWindow, 7);

  const live = list.find((model) => model.id === NEW_MODEL);
  assert.ok(live);
  assert.equal(live.name, "Test Live Only");
  assert.equal(live.provider, "opencode-go");
  assert.equal(live.contextWindow, 123_456);
  assert.equal(live.maxTokens, 4_096);
  assert.equal(live.reasoning, true);
  assert.deepEqual(live.input, ["text", "image"]);
  assert.equal(live.cost.input, 0.5);
  assert.equal(live.cost.output, 2);
  assert.equal(live.cost.cacheRead, 0.05);
  assert.deepEqual(live.thinkingLevelMap, {
    minimal: null,
    medium: null,
    xhigh: null,
    max: null,
  });
});

test("a live-only model without limits or prices stays unknown instead of guessed", async () => {
  const models = createLiveModels({
    credentials: credentialStore(),
    modelsStore: new InMemoryModelsStore(),
    fetch: async () =>
      respond({
        data: [
          {
            id: "test-bare",
            name: "Test Bare",
            type: "chat",
            api: { "chat-completions": {} },
            modalities: { input: ["text"] },
          },
        ],
      }),
  });
  await models.refresh();
  const bare = models.models.getModels("opencode-go").find((model) => model.id === "test-bare");
  assert.equal(bare?.contextWindow, 0);
  assert.equal(bare?.maxTokens, 0);
  assert.deepEqual(bare?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(bare?.reasoning, false);
});

test("the cache feeds an offline start, and a failed refresh keeps it", async () => {
  const store = new InMemoryModelsStore();
  const online = createLiveModels({
    credentials: credentialStore(),
    modelsStore: store,
    fetch: async () => respond(catalog()),
  });
  await online.refresh();
  assert.ok(online.models.getModels("opencode-go").some((model) => model.id === NEW_MODEL));

  const offline = createLiveModels({
    credentials: credentialStore(),
    modelsStore: store,
    fetch: async () => {
      throw new Error("offline");
    },
  });
  await offline.refresh();
  assert.ok(offline.models.getModels("opencode-go").some((model) => model.id === NEW_MODEL));

  const cacheOnly = createLiveModels({
    credentials: credentialStore(),
    modelsStore: store,
    fetch: async () => {
      throw new Error("offline");
    },
  });
  await cacheOnly.models.refresh({ allowNetwork: false });
  const restored = cacheOnly.models.getModels("opencode-go");
  assert.ok(restored.some((model) => model.id === NEW_MODEL));
  assert.ok(restored.some((model) => model.id === "deepseek-v4.1-flash"));
});

test("Pi's runtime restores the live cache and picks up the new model on refresh", async () => {
  await withAgentDirectory(async (agentDirectory) => {
    const store = new InMemoryModelsStore();
    const runtime = await createAeonModelRuntime({
      agentDirectory,
      modelsStore: store,
      fetch: async () => respond(catalog()),
    });
    await runtime.refresh({ allowNetwork: true });
    assert.equal(runtime.getModel("opencode-go", NEW_MODEL)?.name, "Test Live Only");
    assert.notEqual(
      runtime.getModel("opencode-go", "deepseek-v4.1-flash")?.name,
      "A name the live list must not win with",
    );
    const available = await runtime.getAvailable("opencode-go");
    assert.ok(available.some((model) => model.id === NEW_MODEL));

    // A fresh runtime (a restart) sees the stored model before any network call.
    const restarted = await createAeonModelRuntime({
      agentDirectory,
      modelsStore: store,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(restarted.getModel("opencode-go", NEW_MODEL)?.name, "Test Live Only");
  });
});

test("the API key never appears in refresh errors", async () => {
  await withAgentDirectory(async (agentDirectory) => {
    let sent = "";
    const runtime = await createAeonModelRuntime({
      agentDirectory,
      modelsStore: new InMemoryModelsStore(),
      fetch: async (_url, init) => {
        sent = String(init?.headers?.authorization ?? "");
        return denied();
      },
    });
    const result = await runtime.refresh({ allowNetwork: true });
    const error = result.errors.get("opencode-go");
    assert.ok(error, "the refresh reports the failure");
    assert.equal(sent, `Bearer ${SECRET}`, "the key was sent as the bearer token");
    const surfaced = [String(error), error.stack, JSON.stringify([...result.errors])].join("\n");
    assert.ok(!surfaced.includes(SECRET), "no error or log line contains the key");
  });
});
