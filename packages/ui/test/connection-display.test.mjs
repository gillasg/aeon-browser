import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript } from "../dist/chat-transcript.js";
test("waiting for connection shows Connecting without claiming work has started", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTranscript, { rows: [], starting: true, connecting: true }),
  );
  assert.match(html, /Connecting…/);
  assert.doesNotMatch(html, /Working for/);
  const started = renderToStaticMarkup(createElement(ChatTranscript, { rows: [], running: true }));
  assert.match(started, /Working for/);
  assert.doesNotMatch(started, /Connecting/);
});
