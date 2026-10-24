import assert from "node:assert/strict";
import test from "node:test";
import {
  HelloAckSchema,
  HelloRejectionSchema,
  HelloSchema,
  PiBrowserContextRecordSchema,
  ProtocolHandshakeMessageSchema,
  DaemonUiRequestSchema,
  DaemonUiResponseSchema,
  BrowserContextDraftSchema,
  BrowserContextHandoffSchema,
} from "../dist/index.js";

test("hello and server responses share the closed discriminated wire schema", () => {
  assert.equal(HelloSchema.parse(validHello).role, "ui");
  assert.equal(
    ProtocolHandshakeMessageSchema.parse({
      kind: "hello.ack",
      protocolVersion: { major: 1, minor: 0 },
      role: "extension-executor",
      connectionId: "1c8e73dc-f996-4aac-94ae-198773512ab3",
    }).kind,
    "hello.ack",
  );
  assert.equal(
    HelloRejectionSchema.parse({
      kind: "hello.reject",
      stage: "handshake",
      code: "UNSUPPORTED_PROTOCOL_MAJOR",
      supportedProtocolVersion: { major: 1, minor: 0 },
    }).code,
    "UNSUPPORTED_PROTOCOL_MAJOR",
  );
  assert.throws(() => HelloSchema.parse({ ...validHello, unexpected: true }));
  assert.throws(() => HelloAckSchema.parse({ ...validHello, kind: "hello.ack" }));
});

test("Pi-native Edit, navigation, and fork commands have closed request and result DTOs", () => {
  const { chatId, requestId, chat } = prepareProtocolCase1Stage1();
  const { snapshot, cursor } = verifyProtocolCase1Stage2(chatId, requestId, chat);
  verifyProtocolCase1Stage3(chatId, requestId, snapshot, cursor);
});

test("Pi browser-context records are typed, closed, and bounded", () => {
  const target = {
    clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
    browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
    tabId: 19,
    tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
  };
  const selection = {
    contextId: "3d1d98ec-631c-4beb-b2f8-534b38ce34ce",
    kind: "selection",
    capturedAt: "2026-09-28T12:00:00.000Z",
    target,
    url: "https://example.com/article",
    title: "Example article",
    selectedText: "Captured selection",
  };
  assert.equal(PiBrowserContextRecordSchema.parse(selection).selectedText, "Captured selection");
  assert.equal(
    PiBrowserContextRecordSchema.safeParse({ ...selection, selectedText: " " }).success,
    false,
  );
  assert.equal(
    PiBrowserContextRecordSchema.safeParse({ ...selection, unexpected: true }).success,
    false,
  );
  assert.equal(
    PiBrowserContextRecordSchema.safeParse({ ...selection, selectedText: "x".repeat(8001) })
      .success,
    false,
  );
  assert.equal(
    BrowserContextHandoffSchema.parse({
      invocationId: "9cb2ab2f-cf9e-4050-b431-26ab4c71bd5a",
      windowId: 4,
      context: selection,
      autoPrompt: "Summarize this selected text.",
    }).context.target.tabId,
    target.tabId,
  );
  assert.equal(
    BrowserContextDraftSchema.safeParse({
      invocationId: "9cb2ab2f-cf9e-4050-b431-26ab4c71bd5a",
      context: selection,
      unexpected: true,
    }).success,
    false,
  );
});

const validHello = {
  kind: "hello",
  protocolVersion: { major: 1, minor: 0 },
  role: "ui",
  connectionGrant: "A".repeat(43),
};

function prepareProtocolCase1Stage1() {
  const chatId = "fa1772a6-99a4-461c-8a24-d99292ac0839";
  const requestId = "c3b6af80-9aab-4918-b339-23774952f58d";
  const baseRequest = { kind: "command", requestId };
  assert.equal(
    DaemonUiRequestSchema.parse({
      ...baseRequest,
      operation: "chat.edit-message",
      payload: { chatId, entryId: "pi-user-entry-1" },
    }).operation,
    "chat.edit-message",
  );
  assert.equal(
    DaemonUiRequestSchema.parse({
      ...baseRequest,
      operation: "chat.fork-message",
      payload: { chatId, entryId: "pi-assistant-entry-2", title: "Branch" },
    }).operation,
    "chat.fork-message",
  );
  const chat = {
    chatId,
    title: "Test Chat",
    projectId: null,
    origin: "user",
    pinned: false,
    archived: false,
    status: "ready",
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
  };
  return { chatId, requestId, chat };
}

function verifyProtocolCase1Stage2(chatId, requestId, chat) {
  const snapshot = {
    chat,
    runState: "idle",
    contextUsage: null,
    entries: [],
    omittedEntryCount: 0,
  };
  const cursor = { epoch: "95f63b82-ccf0-4b67-a430-4095df2ec0f8", revision: 0 };
  const edited = DaemonUiResponseSchema.parse({
    kind: "command.completed",
    requestId,
    operation: "chat.edit-message",
    result: {
      kind: "chat.message-edited",
      chatId,
      entryId: "pi-user-entry-1",
      status: "ready",
      editorText: "Edit this prompt",
      attachments: [],
      notice: null,
      reason: null,
      snapshot,
      cursor,
    },
  });
  assert.equal(edited.result.kind, "chat.message-edited");
  return { snapshot, cursor };
}

function verifyProtocolCase1Stage3(chatId, requestId, snapshot, cursor) {
  const navigated = DaemonUiResponseSchema.parse({
    kind: "command.completed",
    requestId,
    operation: "chat.navigate-tree",
    result: {
      kind: "chat.tree-navigated",
      entryId: "pi-user-entry-1",
      cancelled: false,
      editorText: "Edit this prompt",
      snapshot,
      cursor,
    },
  });
  assert.equal(navigated.result.kind, "chat.tree-navigated");
  const unsupported = DaemonUiResponseSchema.parse({
    kind: "command.completed",
    requestId,
    operation: "chat.fork-message",
    result: {
      kind: "chat.message-forked",
      sourceChatId: chatId,
      entryId: "pi-user-entry-1",
      status: "unsupported",
      targetChatId: null,
      chat: null,
      reason: "branch_without_assistant",
    },
  });
  assert.equal(unsupported.result.kind, "chat.message-forked");
}
