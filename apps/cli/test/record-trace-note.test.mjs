import assert from "node:assert/strict";
import test from "node:test";
import { traceNote } from "../dist/record-cmd.js";

test("no note when the chat's trace was attached", () => {
  assert.equal(traceNote("chat-1", true), undefined);
});

test("a named chat whose trace could not be read says so, not 'use --chat'", () => {
  const note = traceNote("chat-1", false);
  assert.match(note, /chat-1 could not be read/);
  assert.doesNotMatch(note, /use --chat/);
});

test("no chat named points at --chat on start or stop", () => {
  assert.match(traceNote(undefined, false), /use --chat <id> at start or stop/);
});
