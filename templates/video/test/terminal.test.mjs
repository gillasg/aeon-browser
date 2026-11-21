// The kit draws a terminal pane from events.json `terminal`. Newlines close a line so the next
// chunk, including stderr, does not run on into it.
import assert from "node:assert/strict";
import test from "node:test";
import { terminalFrame, terminalLines } from "../src/terminal.ts";

test("terminal lines close at newlines and the pane sits beside a wide frame", () => {
  const cast = {
    version: 1,
    command: "aeon tool",
    startedAt: 5_000,
    events: [
      { t: 1000, kind: "in", text: "aeon tool" },
      { t: 1040, kind: "out", text: "hello-term\n" },
      { t: 1040, kind: "err", text: "warn\n" },
    ],
  };
  const lines = terminalLines(cast, 1040);
  assert.equal(lines[0].text, "$ aeon tool");
  assert.equal(lines[1].text, "hello-term");
  assert.equal(lines[2].kind, "err");
  assert.equal(lines[2].text, "warn");
  const wide = terminalFrame(1920, 1080, true);
  assert.ok(wide.term.x >= wide.chrome.w);
  assert.ok(wide.term.w > 0);
  const tall = terminalFrame(1080, 1920, true);
  assert.ok(tall.term.y >= tall.chrome.h);
});
