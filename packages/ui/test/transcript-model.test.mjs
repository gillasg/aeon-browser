import assert from "node:assert/strict";
import test from "node:test";
import { projectEditDiff, TranscriptModel } from "../dist/index.js";

test("Pi model errors remain visible as assistant transcript entries", () => {
  const transcript = new TranscriptModel();
  transcript.setSnapshot([
    {
      entryId: "assistant-error-1",
      parentEntryId: null,
      category: "message",
      timestamp: "2026-09-29T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provider request failed",
      },
    },
  ]);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].kind, "entry");
  assert.equal(transcript.rows[0].entry.message.errorMessage, "Provider request failed");
});

test("Pi tool trace groups ordered calls for one active run and starts a new group after settle", () => {
  const transcript = new TranscriptModel();
  transcript.apply({ kind: "run-state", state: "running-unconfirmed" });
  transcript.apply({
    kind: "tool-start",
    toolCallId: "read-1",
    toolName: "read",
    arguments: { path: "README.md" },
  });
  transcript.apply({
    kind: "tool-end",
    toolCallId: "read-1",
    toolName: "read",
    result: "contents",
    isError: false,
  });
  transcript.apply({
    kind: "tool-start",
    toolCallId: "edit-1",
    toolName: "edit",
    arguments: { path: "README.md", oldText: "old", newText: "new" },
  });
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].kind, "tool-group");
  assert.deepEqual(
    transcript.rows[0].group.steps.map((step) => step.toolName),
    ["read", "edit"],
  );

  transcript.apply({ kind: "run-state", state: "idle" });
  transcript.apply({
    kind: "tool-start",
    toolCallId: "later-1",
    toolName: "read",
    arguments: {},
  });
  assert.equal(transcript.rows.length, 2);
});

test("inline edit projection uses only file contents present in Pi tool arguments", () => {
  const step = {
    key: "tool:edit-1",
    toolCallId: "edit-1",
    toolName: "edit",
    arguments: { path: "src/app.ts", oldText: "before", newText: "after" },
    state: "complete",
    partialResult: "",
    result: "ok",
    isError: false,
    startedAt: 0,
    endedAt: 1,
  };
  assert.deepEqual(projectEditDiff(step), {
    path: "src/app.ts",
    rows: [
      { kind: "removed", oldLine: 1, text: "before" },
      { kind: "added", newLine: 1, text: "after" },
    ],
    removed: 1,
    added: 1,
    truncated: false,
    noChanges: false,
    confirmed: false,
  });
  assert.equal(projectEditDiff({ ...step, toolName: "read" }), undefined);
});

test("Pi browser-context entry projects above its unchanged user prompt", () => {
  const record = {
    contextId: "3d1d98ec-631c-4beb-b2f8-534b38ce34ce",
    kind: "selection",
    capturedAt: "2026-09-28T12:00:00.000Z",
    target: {
      clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
      browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
      tabId: 19,
      tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
    },
    url: "https://example.test/article",
    title: "Example article",
    selectedText: "A captured paragraph.",
  };
  const transcript = new TranscriptModel();
  transcript.setSnapshot([
    {
      entryId: "user-entry",
      parentEntryId: null,
      category: "message",
      timestamp: "2026-09-28T12:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Explain this paragraph." }] },
    },
    {
      entryId: "context-entry",
      parentEntryId: "user-entry",
      category: "message",
      timestamp: "2026-09-28T12:00:00.001Z",
      message: { role: "custom", content: [{ type: "browser-context", record }] },
    },
  ]);

  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].kind, "entry");
  assert.deepEqual(transcript.rows[0].entry.message.content, [
    { type: "browser-context", record },
    { type: "text", text: "Explain this paragraph." },
  ]);
});

test("browser context targets its exact user entry when replayed before that entry", () => {
  const record = makeRecord();
  const transcript = new TranscriptModel();
  transcript.setSnapshot([
    userEntry("earlier-user", "Earlier prompt"),
    {
      entryId: "context-for-new-user",
      parentEntryId: "new-user",
      category: "message",
      timestamp: "2026-09-28T12:00:00.001Z",
      message: { role: "custom", content: [{ type: "browser-context", record }] },
    },
    userEntry("new-user", "Exact new prompt"),
  ]);

  assert.equal(transcript.rows.length, 2);
  const earlier = transcript.rows[0];
  const exact = transcript.rows[1];
  assert.equal(earlier.kind, "entry");
  assert.deepEqual(earlier.entry.message.content, [{ type: "text", text: "Earlier prompt" }]);
  assert.equal(exact.kind, "entry");
  assert.deepEqual(exact.entry.message.content, [
    { type: "browser-context", record },
    { type: "text", text: "Exact new prompt" },
  ]);
});

test("unmatched browser context remains an orphan custom row", () => {
  const record = makeRecord();
  const transcript = new TranscriptModel();
  transcript.setSnapshot([
    userEntry("earlier-user", "Earlier prompt"),
    {
      entryId: "orphan-context",
      parentEntryId: "missing-user",
      category: "message",
      timestamp: "2026-09-28T12:00:00.001Z",
      message: { role: "custom", content: [{ type: "browser-context", record }] },
    },
  ]);

  assert.equal(transcript.rows.length, 2);
  assert.equal(transcript.rows[0].entry.entryId, "earlier-user");
  assert.equal(transcript.rows[1].kind, "context-orphan");
  assert.equal(transcript.rows[1].entry.message.role, "custom");
  assert.equal(transcript.rows[1].targetEntryId, "missing-user");
});

test("thread deliveries remain visible as Pi-owned causal transcript cards", () => {
  const block = {
    type: "thread-message",
    deliveryId: "83b74486-74be-42b3-9fc6-7e1e046c5f35",
    senderChatId: "a203ce14-e3df-4552-b2ca-26471f25a634",
    senderTitle: "Planner",
    message: "Inspect the latest build result.",
    inReplyTo: "f245df80-f382-48a1-aac5-2ff84508ed75",
  };
  const transcript = new TranscriptModel();
  const entry = {
    entryId: "thread-message-entry",
    parentEntryId: "source-entry",
    category: "message",
    timestamp: "2026-09-28T12:00:00.001Z",
    message: { role: "custom", content: [block] },
  };

  transcript.setSnapshot([entry]);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].entry.entryId, "thread-message-entry");
  assert.deepEqual(transcript.rows[0].entry.message.content[0], block);

  transcript.apply({ kind: "entry-added", entry });
  assert.equal(transcript.rows.length, 1);
});

function userEntry(entryId, text) {
  return {
    entryId,
    parentEntryId: null,
    category: "message",
    timestamp: "2026-09-28T12:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function makeRecord() {
  return {
    contextId: "f7048ed4-7f44-4948-82b5-9263054b8143",
    kind: "selection",
    capturedAt: "2026-09-28T12:00:00.000Z",
    target: {
      clientInstanceId: "fc4c0e1b-ab37-4374-bf59-8e4ee66dbefd",
      browserRunId: "0c51b95a-6394-4ad0-b31b-4fb069699b50",
      tabId: 19,
      tabIncarnation: "5b476787-185f-4801-867d-66572763487f",
    },
    url: "https://example.test/article",
    title: "Example article",
    selectedText: "A captured paragraph.",
  };
}
