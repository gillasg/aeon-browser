import assert from "node:assert/strict";
import test from "node:test";
import { answer, send, waitForChange } from "../dist/converse.js";

// A stand-in daemon: answers the commands converse.ts sends and records them.
function fakeClient({ active = false, dialogs = [], runState = "idle", entries = [] } = {}) {
  const sent = [];
  return {
    sent,
    async command(operation, payload) {
      sent.push({ operation, payload });
      if (operation === "chat.pi-ui") return { piUi: { extensionDialogs: dialogs } };
      if (operation === "chat.controls")
        return {
          controls: {
            active,
            effectiveModel: { provider: "p", id: "m", name: "M" },
            thinkingLevel: "high",
          },
        };
      if (operation === "chat.extension-ui-answer") return { accepted: true };
      if (operation === "chat.get")
        return {
          snapshot: {
            chat: { chatId: payload.chatId, title: "t" },
            runState,
            contextUsage: null,
            entries,
          },
        };
      return {};
    },
    async submit(chatId, text, selection) {
      sent.push({ operation: "chat.submit", payload: { chatId, text, selection } });
    },
  };
}

const dialog = (kind, options = []) => ({
  requestId: "11111111-1111-4111-8111-111111111111",
  kind,
  title: "Which size?",
  message: null,
  options,
  placeholder: null,
  prefill: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

test("send queues a follow-up while the chat works, and starts a turn when idle", async () => {
  const busy = fakeClient({ active: true });
  assert.deepEqual(await send(busy, "c", "also check prices"), { mode: "followUp" });
  assert.equal(busy.sent.at(-1).operation, "chat.queue");
  assert.equal(busy.sent.at(-1).payload.typedByUser, undefined);
  assert.deepEqual(await send(busy, "c", "stop that", { steer: true }), { mode: "steer" });
  const idle = fakeClient();
  assert.deepEqual(await send(idle, "c", "now the next one"), { mode: "sent" });
  assert.deepEqual(idle.sent.at(-1).payload.selection, {
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
  });
});

test("answers fit the question: yes/no, a choice or its number, text", async () => {
  const select = fakeClient({ dialogs: [dialog("select", ["Small", "Large"])] });
  assert.equal((await answer(select, "c", "2")).answered, "Large");
  assert.equal((await answer(select, "c", "small")).answered, "Small");
  await assert.rejects(answer(select, "c", "huge"), /Pick one of/);
  const confirm = fakeClient({ dialogs: [dialog("confirm")] });
  await answer(confirm, "c", "yes");
  assert.equal(confirm.sent.at(-1).payload.value, true);
  await assert.rejects(answer(fakeClient(), "c", "yes"), /not waiting on a question/);
});

test("wait returns at once on a question or an idle chat", async () => {
  const asking = await waitForChange(
    fakeClient({ runState: "running-unconfirmed", dialogs: [dialog("input")] }),
    "c",
    { timeoutMs: 5000 },
  );
  assert.equal(asking.changed, true);
  assert.equal(asking.questions[0].question, "Which size?");
  const idle = await waitForChange(fakeClient(), "c", { timeoutMs: 5000 });
  assert.equal(idle.working, false);
  const quiet = await waitForChange(fakeClient({ runState: "running-unconfirmed" }), "c", {
    timeoutMs: 1,
  });
  assert.equal(quiet.changed, false);
});
