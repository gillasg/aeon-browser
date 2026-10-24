import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSiteRules, namedHosts } from "../dist/browser-site-rules.js";

test("a routine's sites restrict its own run, never the chat's other runs", () => {
  const rules = new BrowserSiteRules();
  rules.notePrompt("chat-1", "Check the lamp price on shop.example please");
  assert.deepEqual(rules.answer("chat-1"), {
    blocked: [],
    only: [],
    allow: ["shop.example"],
  });

  rules.beginRoutineRun("chat-1", "run-1", "Watch the lamp on shop.example", ["shop.example"]);
  assert.deepEqual(rules.answer("chat-1"), {
    blocked: [],
    only: ["shop.example"],
    allow: ["shop.example"],
  });

  // The user's own next message in the same chat is not restricted by a routine that merely exists.
  rules.endRoutineRun("chat-1", "run-1");
  assert.deepEqual(rules.answer("chat-1"), {
    blocked: [],
    only: [],
    allow: ["shop.example"],
  });
});

test("a routine's instruction is its allow list; a check value never is", () => {
  const rules = new BrowserSiteRules();
  rules.beginRoutineRun("chat-1", "run-1", "Tell me when example.com changes", []);
  assert.deepEqual(rules.answer("chat-1").allow, ["example.com"]);
  rules.endRoutineRun("chat-1", "run-1");
  assert.deepEqual(rules.answer("chat-1"), { blocked: [], only: [], allow: [] });
});

test("ending an unknown or already ended run changes nothing, and chats stay separate", () => {
  const rules = new BrowserSiteRules();
  rules.endRoutineRun("chat-1", "missing");
  rules.beginRoutineRun("chat-1", "run-1", "", ["only.example"]);
  rules.beginRoutineRun("chat-2", "run-2", "", ["other.example"]);
  assert.deepEqual(rules.answer("chat-1").only, ["only.example"]);
  assert.deepEqual(rules.answer("chat-2").only, ["other.example"]);
  rules.endRoutineRun("chat-1", "run-1");
  rules.endRoutineRun("chat-1", "run-1");
  assert.deepEqual(rules.answer("chat-1"), { blocked: [], only: [], allow: [] });
});

test("namedHosts reads URLs and bare domains, not protocol or local names", () => {
  assert.deepEqual(namedHosts("go to https://www.Example.com/login and evil.test"), [
    "example.com",
    "evil.test",
  ]);
  assert.deepEqual(namedHosts("nothing here"), []);
  assert.deepEqual(namedHosts("file:///c:/tmp/x"), []);
});
