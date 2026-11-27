// A code the agent read from a tool result must not flash in a streaming message_update. Masking
// only at message_end is too late: the UI already showed the digits. The store is per chat.
import assert from "node:assert/strict";
import test from "node:test";
import { wrapPiSession } from "../dist/session-projection.js";

function sessionFor(chatId) {
  const listeners = new Set();
  const events = [];
  const entries = [];
  const manager = {
    getEntries: () => entries,
    getBranch: () => entries,
    getCwd: () => "/",
    getEntry: () => undefined,
  };
  const session = {
    isIdle: false,
    isStreaming: true,
    sessionManager: manager,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const extensionUi = {
    snapshot: () => ({ dialogs: [] }),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  const handle = wrapPiSession(
    session,
    manager,
    { sessionFile: `/tmp/graft-code-stream-${chatId}.jsonl` },
    chatId,
    extensionUi,
    () => [],
  );
  handle.subscribe((event) => events.push(event));
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { emit, events };
}

const text = (value) => [{ type: "text", text: value }];

test("a streaming assistant update never shows a code read from a tool result", () => {
  const { emit, events } = sessionFor("chat-stream-1");
  emit({
    type: "tool_execution_end",
    toolCallId: "tc1",
    toolName: "browser_code",
    isError: false,
    result: text("Your verification code is 482913. Enter it to sign in."),
  });
  emit({
    type: "message_update",
    message: {
      role: "assistant",
      content: text("I read the code 482913 and will type it now."),
    },
  });
  const update = events.find((event) => event.kind === "message-update");
  assert.ok(update, "the update was projected");
  const shown = update.message.content.map((block) => block.text ?? "").join(" ");
  assert.equal(shown.includes("482913"), false, "no digits in the streaming update");
  assert.match(shown, /\[removed\]/);
});

test("a code noted in one chat does not mask another chat's answer", () => {
  const a = sessionFor("chat-isolate-a");
  a.emit({
    type: "tool_execution_end",
    toolCallId: "tc1",
    toolName: "browser_code",
    isError: false,
    result: text("Your verification code is 770011."),
  });
  const b = sessionFor("chat-isolate-b");
  b.emit({
    type: "message_update",
    message: { role: "assistant", content: text("Order total is 770011.") },
  });
  const shown = b.events
    .find((event) => event.kind === "message-update")
    .message.content.map((block) => block.text ?? "")
    .join(" ");
  assert.match(shown, /770011/, "the other chat never noted that code");
});
