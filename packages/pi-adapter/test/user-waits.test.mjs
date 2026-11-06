import assert from "node:assert/strict";
import test from "node:test";
import { createAskUserTool } from "../dist/ask-user-tool.js";
import { endUserWaits, openUserWait, STEERED_NOTE } from "../dist/user-waits.js";

// A dialog that never answers by itself: only its signal (or the race) ends it.
const silentUi = {
  confirm: () => new Promise(() => {}),
  select: () => new Promise(() => {}),
  input: () => new Promise(() => {}),
};

function ask(chatId, signal) {
  const tool = createAskUserTool(chatId);
  return tool.execute("call", { question: "Which plan?" }, signal, undefined, {
    hasUI: true,
    ui: silentUi,
  });
}

test("a steer ends an open ask_user question at once, with a note to read the message", async () => {
  const pending = ask("chat-steer");
  await Promise.resolve();
  assert.equal(endUserWaits("chat-steer"), 1);
  const result = await pending;
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.answer, null);
  assert.equal(value.note, STEERED_NOTE);
});

test("a stop ends an open ask_user question at once", async () => {
  const stop = new globalThis.AbortController();
  const pending = ask("chat-stop", stop.signal);
  await Promise.resolve();
  stop.abort();
  const value = JSON.parse((await pending).content[0].text);
  assert.equal(value.answer, null);
  assert.notEqual(value.note, STEERED_NOTE);
});

test("a steer leaves a gated wait alone until its gate opens (a cell not handing off)", () => {
  let handingOff = false;
  const wait = openUserWait("chat-gate", undefined, () => handingOff);
  assert.equal(endUserWaits("chat-gate"), 0);
  assert.equal(wait.signal.aborted, false);
  handingOff = true;
  assert.equal(endUserWaits("chat-gate"), 1);
  assert.equal(wait.signal.aborted, true);
  assert.equal(wait.steered(), true);
  wait.close();
  assert.equal(endUserWaits("chat-gate"), 0);
});

test("a steer in one chat never ends another chat's wait", () => {
  const other = openUserWait("chat-b");
  assert.equal(endUserWaits("chat-a"), 0);
  assert.equal(other.signal.aborted, false);
  other.close();
});
