import assert from "node:assert/strict";
import test from "node:test";
import {
  PiEntrySchema,
  DaemonUiRequestSchema,
  DaemonUiResponseSchema,
  BrowserExecutorRequestSchema,
  BrowserOperationCallSchema,
  BrowserExecutorResultSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "../dist/index.js";

test("thread-message Pi content blocks carry typed delivery and reply provenance", () => {
  const entry = {
    entryId: "pi-thread-entry",
    parentEntryId: null,
    category: "message",
    timestamp: "2026-09-28T12:00:00.000Z",
    message: {
      role: "custom",
      content: [
        {
          type: "thread-message",
          deliveryId: "83b74486-74be-42b3-9fc6-7e1e046c5f35",
          senderChatId: "a203ce14-e3df-4552-b2ca-26471f25a634",
          senderTitle: "Planner",
          message: "Inspect the latest build result.",
          inReplyTo: "f245df80-f382-48a1-aac5-2ff84508ed75",
        },
      ],
    },
  };
  assert.equal(PiEntrySchema.parse(entry).message.content[0].type, "thread-message");
  assert.equal(
    PiEntrySchema.safeParse({ ...entry, message: { ...entry.message, extra: true } }).success,
    false,
  );
});

test("chat and browser commands use version 1.7 and bound image and text attachments", () => {
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSION, { major: 1, minor: 7 });
  const chatId = "1c8e73dc-f996-4aac-94ae-198773512ab3";
  const valid = {
    kind: "command",
    requestId: "dc92e26f-b0b1-4d47-a6e5-64f36440c2ba",
    operation: "chat.submit",
    payload: {
      chatId,
      text: "Describe this file",
      attachments: [{ name: "note.txt", mimeType: "text/plain", data: "YQ==", byteLength: 1 }],
    },
  };
  assert.equal(DaemonUiRequestSchema.parse(valid).kind, "command");
  assert.equal(
    DaemonUiRequestSchema.safeParse({
      ...valid,
      payload: {
        ...valid.payload,
        attachments: [
          { name: "note.txt", mimeType: "text/plain", data: "not base64", byteLength: 8 },
        ],
      },
    }).success,
    false,
  );
  const large = {
    name: "large.png",
    mimeType: "image/png",
    data: "A".repeat(1_066_668),
    byteLength: 800_000,
  };
  assert.equal(
    DaemonUiRequestSchema.safeParse({
      ...valid,
      payload: { ...valid.payload, attachments: [large, large, large] },
    }).success,
    false,
  );
});

test("model catalog wire data is closed and carries Pi-supported effort per model", () => {
  const request = {
    kind: "command",
    requestId: "dc92e26f-b0b1-4d47-a6e5-64f36440c2ba",
    operation: "chat.model-catalog",
    payload: {},
  };
  assert.equal(DaemonUiRequestSchema.parse(request).operation, "chat.model-catalog");
  assert.equal(
    DaemonUiRequestSchema.safeParse({ ...request, payload: { chatId: "not-needed" } }).success,
    false,
  );
  const response = {
    kind: "command.completed",
    requestId: request.requestId,
    operation: "chat.model-catalog",
    result: {
      kind: "chat.model-catalog",
      catalog: {
        defaultModel: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
        models: [
          {
            provider: "openai-codex",
            id: "gpt-6-luna",
            name: "GPT-6 Luna",
            thinkingLevels: ["off", "low", "medium"],
            defaultThinkingLevel: "medium",
          },
        ],
      },
    },
  };
  assert.equal(
    DaemonUiResponseSchema.parse(response).result.catalog.models[0].thinkingLevels[2],
    "medium",
  );
  assert.equal(
    DaemonUiResponseSchema.safeParse({
      ...response,
      result: { ...response.result, catalog: { ...response.result.catalog, unexpected: true } },
    }).success,
    false,
  );
});

test("browser tool input is a closed batch of at most eight safe operations", () => {
  const target = {
    clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
    browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
    tabId: 9,
    tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
  };
  const valid = {
    steps: [
      {
        op: "openTab",
        clientInstanceId: target.clientInstanceId,
        url: "https://example.test/",
        foreground: false,
      },
    ],
  };
  assert.equal(BrowserOperationCallSchema.parse(valid).steps[0].op, "openTab");
  assert.equal(BrowserOperationCallSchema.safeParse({ ...valid, extra: true }).success, false);
  assert.equal(
    BrowserOperationCallSchema.safeParse({
      steps: [{ op: "openTab", clientInstanceId: target.clientInstanceId, url: "file:///secret" }],
    }).success,
    false,
  );
  assert.equal(
    BrowserOperationCallSchema.safeParse({ steps: Array(9).fill({ op: "listTabs" }) }).success,
    false,
  );
  assert.equal(
    BrowserOperationCallSchema.safeParse({ steps: [{ op: "closeOwnedTab", target }] }).success,
    false,
  );
  assert.equal(
    BrowserOperationCallSchema.safeParse({
      steps: [
        {
          op: "fill",
          target,
          element: {
            kind: "point",
            screenshotId: "3d1d98ec-631c-4beb-b2f8-534b38ce34ce",
            x: 0.4,
            y: 0.5,
          },
          value: "x",
        },
      ],
    }).success,
    false,
  );
});

test("browser executor target actions: reads may omit or carry a claim, writes require one, and semantic data is marked untrusted", () => {
  const request = {
    kind: "browser.operation",
    requestId: "2a1e40f0-43fc-4797-a7ea-215f83c77f5c",
    operationId: "d2e1514f-53b0-4f03-a0d1-8c2b6b5f6240",
    toolCallId: "toolu_test",
    chatId: "968c135b-a48f-4f5e-9223-dff7f9a10a07",
    step: {
      op: "observe",
      target: {
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
        tabId: 9,
        tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
      },
      kind: "semantic",
    },
  };
  assert.equal(BrowserExecutorRequestSchema.safeParse(request).success, true);
  assert.equal(
    BrowserExecutorRequestSchema.safeParse({
      ...request,
      claimId: "718cae36-3f78-49df-a502-85dfe9f6e9a0",
      claimGeneration: 1,
      expectedDocumentEpoch: 0,
    }).success,
    true,
  );
  const observation = {
    kind: "semantic",
    source: "website",
    trust: "untrusted",
    target: request.step.target,
    documentEpoch: 0,
    snapshotId: "3d1d98ec-631c-4beb-b2f8-534b38ce34ce",
    url: "https://example.test/",
    nodes: [],
    truncated: false,
  };
  assert.equal(BrowserExecutorResultSchema.parse(observation).trust, "untrusted");
  assert.equal(
    BrowserExecutorResultSchema.safeParse({ ...observation, script: "alert(1)" }).success,
    false,
  );
});
