import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PickerChevron } from "../dist/picker-chevron.js";
import { TranscriptTurn } from "../dist/transcript-turn.js";
import { TranscriptMessage } from "../dist/transcript-message.js";

const row = (key, content, stopReason = "toolUse") => ({
  kind: "entry",
  key,
  entry: {
    entryId: key,
    parentEntryId: null,
    category: "message",
    timestamp: "2026-10-01T00:00:00Z",
    message: { role: "assistant", content, stopReason },
  },
});

test("picker carets have intrinsic dimensions and stroke without any stylesheet", () => {
  const html = renderToStaticMarkup(createElement(PickerChevron));
  assert.match(html, /width="12" height="12"/);
  assert.match(html, /fill="none" stroke="currentColor"/);
});

test("empty thinking and tool-only assistant messages create no empty rows", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptMessage, {
      row: row("empty", [
        { type: "thinking", text: "" },
        { type: "tool-call", toolCallId: "call", toolName: "browser_tabs", arguments: {} },
      ]),
      actionsDisabled: false,
    }),
  );
  assert.equal(html, "");
});

test("tool turns preserve ordered thinking disclosures inside the aggregate", () => {
  const rows = [
    row("before", [{ type: "thinking", text: "**Planning the request**" }]),
    {
      kind: "tool-group",
      key: "tools",
      group: {
        key: "tools",
        steps: [
          {
            key: "call",
            toolCallId: "call",
            toolName: "browser_tabs",
            arguments: {},
            state: "complete",
            partialResult: "",
            result: "[]",
            isError: false,
            startedAt: 1000,
            endedAt: 2000,
          },
        ],
      },
    },
    row(
      "answer",
      [
        { type: "thinking", text: "**Checking the result**" },
        { type: "text", text: "Final answer." },
      ],
      "stop",
    ),
  ];
  const html = renderToStaticMarkup(
    createElement(TranscriptTurn, { rows, actions: { actionsDisabled: false } }),
  );
  assert.equal((html.match(/class="thinking-detail"/g) ?? []).length, 2);
  assert.ok(html.indexOf('class="thinking-detail"') < html.indexOf('class="activity-group"'));
  assert.ok(html.indexOf('class="thinking-detail"') < html.indexOf("Final answer."));
  assert.match(html, /<strong>Planning the request<\/strong>/);
  assert.match(html, /<strong>Checking the result<\/strong>/);
  assert.doesNotMatch(html, /\*\*/);
});
