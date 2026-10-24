import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript } from "../dist/chat-transcript.js";
import { MessageActions } from "../dist/message-actions.js";

const entry = (id, role, text, stopReason) => ({
  entryId: id,
  parentEntryId: null,
  category: "message",
  timestamp: "2026-10-01T00:00:00Z",
  message: { role, content: [{ type: "text", text }], stopReason },
});

const turn = (index, question, answer) => [
  { kind: "entry", key: `u${index}`, entry: entry(`u${index}`, "user", question) },
  { kind: "entry", key: `a${index}`, entry: entry(`a${index}`, "assistant", answer, "stop") },
];

test("the transcript rail has one notch per user message, with a preview", () => {
  const rows = [
    ...turn(1, "Find a desk lamp", "The lamp is 25."),
    ...turn(2, "Now compare two", "Lamp A wins."),
  ];
  const html = renderToStaticMarkup(
    createElement(ChatTranscript, { rows, actionsDisabled: false }),
  );
  assert.equal((html.match(/transcript-rail-tick/g) ?? []).length, 2);
  assert.match(html, /Message 1 of 2: Find a desk lamp/);
  assert.match(html, /Message 2 of 2: Now compare two/);
});

test("assistant actions no longer pin answers to home", () => {
  const message = entry("a1", "assistant", "Answer", "stop").message;
  const html = renderToStaticMarkup(
    createElement(MessageActions, {
      message,
      entry: entry("a1", "assistant", "Answer", "stop"),
      onBranchEntry: () => undefined,
      actionsDisabled: false,
      text: "Answer",
    }),
  );
  assert.doesNotMatch(html, /Pin answer|Keep this answer/);
  assert.match(html, /message-branch/);
});
