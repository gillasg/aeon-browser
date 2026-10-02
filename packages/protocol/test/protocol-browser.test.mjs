import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatViewSnapshotSchema,
  ManagementSnapshotSchema,
  PiSessionEventSchema,
} from "../dist/index.js";

test("Pi nested trace DTO preserves parent IDs and bounded persisted child summaries", () => {
  assert.equal(
    PiSessionEventSchema.parse({ kind: "run-state", state: "needs_attention" }).state,
    "needs_attention",
  );
  const event = PiSessionEventSchema.parse({
    kind: "tool-start",
    toolCallId: "codemode/1",
    toolName: "mcp__docs__search",
    arguments: { query: "reference" },
    parentToolCallId: "codemode",
  });
  assert.equal(event.parentToolCallId, "codemode");
  assert.equal(
    PiSessionEventSchema.safeParse({
      ...event,
      parentToolCallId: "p".repeat(201),
    }).success,
    false,
  );

  const message = PiSessionEventSchema.parse({
    kind: "message-end",
    message: {
      role: "tool",
      content: [],
      toolCallId: "codemode",
      toolName: "codemode",
      isError: false,
      nestedCalls: {
        complete: true,
        calls: [
          {
            id: "codemode/1",
            name: "mcp__docs__search",
            arguments: { query: "reference" },
            status: "ok",
            durationMs: 23,
          },
        ],
      },
    },
  });
  assert.equal(message.message.nestedCalls.calls[0].status, "ok");
});

test("Pi context usage is typed in snapshots and live events, including unknown post-compaction usage", () => {
  const contextUsage = {
    tokens: 12_345,
    availableTokens: 87_655,
    contextWindow: 100_000,
    percent: 12.345,
  };
  const snapshot = ChatViewSnapshotSchema.parse({
    chat: {
      chatId: "1c8e73dc-f996-4aac-94ae-198773512ab3",
      title: "Example",
      projectId: null,
      pinned: false,
      archived: false,
      status: "ready",
      createdAt: "2026-09-28T12:00:00.000Z",
      updatedAt: "2026-09-28T12:00:00.000Z",
    },
    runState: "idle",
    contextUsage,
    entries: [],
    omittedEntryCount: 0,
  });
  assert.deepEqual(snapshot.contextUsage, contextUsage);
  assert.deepEqual(
    PiSessionEventSchema.parse({ kind: "context-usage", contextUsage }).contextUsage,
    contextUsage,
  );

  const unknownAfterCompaction = {
    tokens: null,
    availableTokens: null,
    contextWindow: 100_000,
    percent: null,
  };
  assert.deepEqual(
    PiSessionEventSchema.parse({ kind: "context-usage", contextUsage: unknownAfterCompaction })
      .contextUsage,
    unknownAfterCompaction,
  );
  assert.equal(
    PiSessionEventSchema.safeParse({
      kind: "context-usage",
      contextUsage: { ...unknownAfterCompaction, tokens: -1 },
    }).success,
    false,
  );
});

test("management DTO distinguishes environment references from manual Pi credential binding", () => {
  const capability = {
    id: "cap_external_mcp",
    kind: "mcp",
    displayName: "External MCP",
    description: "A manually authenticated MCP server.",
    configReference: "local-registry",
    relatedSkillIds: [],
    credentialConfigured: true,
    credentialBinding: "manual_pi_binding_required",
    verification: { state: "needs_check", checkedAt: null, summary: null },
    connectionState: "disabled",
    loadedInSelectedChat: null,
  };
  assert.equal(
    ManagementSnapshotSchema.parse({
      chats: [],
      routines: [],
      capabilityRevision: 1,
      capabilities: [capability],
      resources: null,
      resourceError: null,
    }).capabilities[0].credentialBinding,
    "manual_pi_binding_required",
  );
  assert.equal(
    ManagementSnapshotSchema.safeParse({
      chats: [],
      routines: [],
      capabilityRevision: 1,
      capabilities: [{ ...capability, credentialBinding: "secret_value" }],
      resources: null,
      resourceError: null,
    }).success,
    false,
  );
});
