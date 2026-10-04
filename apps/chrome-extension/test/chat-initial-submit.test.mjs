import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("native Chat takes and submits its staged first prompt", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pippin-chat-initial-submit-test-"));
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, removeItem() {} };
  globalThis.document = { body: { dataset: {} } };
  const chatId = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
  const requestId = randomUUID();
  const submitted = [];
  try {
    globalThis.chrome = {
      storage: { session: { get: async () => ({}) } },
      runtime: {
        sendMessage: async (request) => takeInitialSubmit(request, chatId, requestId),
      },
    };
    const modulePath = join(temporaryDirectory, "chat-initial-submit.mjs");
    await build({
      entryPoints: [join(extensionRoot, "src/chat-initial-submit.ts")],
      outfile: modulePath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      define: { __PIPPIN_NATIVE_TRANSPORT__: "true" },
    });
    const { submitInitialPrompt } = await import(pathToFileURL(modulePath).href);
    const client = recordingClient(submitted, chatId, requestId);
    assert.equal(await submitInitialPrompt(chatId, client, true), true);
    assertInitialCommands(submitted, chatId);
  } finally {
    globalThis.document = previousDocument;
    globalThis.sessionStorage = previousStorage;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function takeInitialSubmit(request, chatId, requestId) {
  assert.deepEqual(request, { kind: "pippin.native.take-initial-submit", chatId });
  return {
    ok: true,
    requestId,
    text: "First prompt",
    model: { provider: "pippin-fixture", id: "model-one" },
    thinkingLevel: "low",
  };
}

function recordingClient(submitted, chatId, requestId) {
  return {
    send(request) {
      submitted.push(request);
      return submitted.length;
    },
    async waitFor(predicate, after) {
      const request = submitted[after - 1];
      const response = commandResponse(request, chatId, requestId);
      assert.equal(predicate(response), true);
      return response;
    },
  };
}

function commandResponse(request, chatId, requestId) {
  if (request.operation === "chat.submit")
    return {
      kind: "command.started",
      requestId,
      operation: "chat.submit",
      chatId,
      state: "processing",
      piAcceptance: "unknown",
    };
  return {
    kind: "command.completed",
    requestId: request.requestId,
    operation: request.operation,
    result: { kind: request.operation },
  };
}

function assertInitialCommands(submitted, chatId) {
  assert.equal(submitted.length, 3);
  assert.equal(submitted[0].operation, "chat.model");
  assert.deepEqual(submitted[0].payload, { chatId, provider: "pippin-fixture", id: "model-one" });
  assert.equal(submitted[1].operation, "chat.thinking");
  assert.deepEqual(submitted[1].payload, { chatId, level: "low" });
  assert.equal(submitted[2].operation, "chat.submit");
  assert.deepEqual(submitted[2].payload, {
    chatId,
    text: "First prompt",
    attachments: [],
    browserContexts: [],
  });
}
