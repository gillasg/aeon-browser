import assert from "node:assert/strict";
import test from "node:test";
import { contextBlocks, turnContextDelta } from "../dist/turn-context-delta.js";
import { submitToPi } from "../dist/session-controls.js";

const context = (now, tabs = "mail.example · Inbox") =>
  [
    `[now] ${now}`,
    "[page] shop.example · Orders",
    "[saved] none",
    "[api] none",
    `[tabs] ${tabs}`,
  ].join("\n");

test("a multi-line block stays one block", () => {
  const blocks = contextBlocks("[now] x\n[page] a — b\nselected\n[tabs] none");
  assert.deepEqual(
    blocks.map(([tag]) => tag),
    ["now", "page", "tabs"],
  );
  assert.equal(blocks[1][1], "[page] a — b\nselected");
});

test("the first turn sends everything; an unchanged follow-up sends only the clock", () => {
  const owner = {};
  const first = turnContextDelta(owner, context("09:00"), ["banner A"]);
  assert.match(first, /\[page\]/);
  assert.match(first, /banner A/);
  const second = turnContextDelta(owner, context("09:01"), ["banner A"]);
  assert.equal(second, "[now] 09:01");
});

test("a changed line or a new banner is sent again, alone", () => {
  const owner = {};
  turnContextDelta(owner, context("09:00"), ["banner A"]);
  const next = turnContextDelta(owner, context("09:02", "none"), ["banner B"]);
  assert.equal(next, "[now] 09:02\n[tabs] none\n\nbanner B");
});

test("every sixth turn the whole block goes out again", () => {
  const owner = {};
  const sent = [];
  for (let i = 0; i < 7; i++) sent.push(turnContextDelta(owner, context("09:00"), []));
  assert.match(sent[0], /\[page\]/);
  for (const turn of sent.slice(1, 6)) assert.equal(turn, "[now] 09:00");
  assert.match(sent[6], /\[page\]/);
});

test("submitToPi sends the full context first and a delta on the follow-up", async () => {
  const custom = [];
  const session = {
    subscribe() {},
    async sendCustomMessage(message) {
      custom.push(message.content);
    },
    async prompt() {},
  };
  await submitToPi(session, { text: "hello" });
  await submitToPi(session, { text: "and again" });
  assert.match(custom[0], /\[tabs\]/);
  assert.ok(custom[1].length < custom[0].length, JSON.stringify(custom));
  assert.match(custom[1], /^\[now\] /);
  assert.doesNotMatch(custom[1], /\[tabs\]|\[saved\]/);
});
