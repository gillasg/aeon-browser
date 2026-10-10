import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("native first-prompt handoff is tab/chat-bound, expiring, and one-use", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "aeon-initial-submit-test-"));
  const priorChrome = globalThis.chrome;
  try {
    const records = new Map();
    const handoff = await loadHandoffModule(temporaryDirectory);
    globalThis.chrome = chromeStorageMock(records);
    await verifyOneUseAndIdentity(handoff, records);
    await verifyExpiry(handoff);
  } finally {
    if (priorChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = priorChrome;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function loadHandoffModule(temporaryDirectory) {
  const modulePath = join(temporaryDirectory, "native-initial-submit.mjs");
  await build({
    entryPoints: [join(extensionRoot, "src/native-initial-submit.ts")],
    outfile: modulePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(pathToFileURL(modulePath).href);
}

function chromeStorageMock(records) {
  return {
    storage: {
      session: {
        async set(values) {
          for (const [key, value] of Object.entries(values)) records.set(key, value);
        },
        async get(key) {
          return { [key]: records.get(key) };
        },
        async remove(key) {
          records.delete(key);
        },
      },
    },
  };
}

async function verifyOneUseAndIdentity(handoff, records) {
  const tabId = 42;
  const chatId = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
  const requestId = randomUUID();
  const initialSubmit = {
    requestId,
    text: "synthetic one-use handoff check",
    model: { provider: "aeon-fixture", id: "model-one" },
    thinkingLevel: "off",
  };
  await handoff.stageInitialSubmit(tabId, chatId, initialSubmit);
  assert.equal(await handoff.takeInitialSubmit(tabId + 1, chatId), undefined);
  const stored = records.get(`aeon.initial-submit.${tabId}`);
  assert.deepEqual(handoff.validateInitialSubmitRecord(stored, tabId, chatId), initialSubmit);
  assert.equal(
    handoff.validateInitialSubmitRecord(stored, tabId, "005cfe90-b334-4b04-bb8e-e50b091f2fe5"),
    undefined,
  );
  const takes = await Promise.all([
    handoff.takeInitialSubmit(tabId, chatId),
    handoff.takeInitialSubmit(tabId, chatId),
  ]);
  assert.equal(takes.filter(Boolean).length, 1);
  assert.deepEqual(takes.find(Boolean), initialSubmit);
}

async function verifyExpiry(handoff) {
  const realNow = Date.now;
  try {
    Date.now = () => 1_000;
    await handoff.stageInitialSubmit(42, "968c135b-a48f-4f5e-9223-dff7f9a10a07", {
      requestId: randomUUID(),
      text: "expires",
      model: { provider: "aeon-fixture", id: "model-one" },
      thinkingLevel: "off",
    });
    Date.now = () => 121_000;
    assert.equal(
      await handoff.takeInitialSubmit(42, "968c135b-a48f-4f5e-9223-dff7f9a10a07"),
      undefined,
    );
  } finally {
    Date.now = realNow;
  }
}
