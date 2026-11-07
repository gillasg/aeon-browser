import assert from "node:assert/strict";
import test from "node:test";

const sent = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_target, method, params) => sent.push([method, params]),
    onEvent: { addListener() {} },
  },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
};
const { answerDialog, noteAgentClick, takeFedCmNote } =
  await import("../dist/native-browser-fedcm.js");

const one = {
  dialogId: "d1",
  dialogType: "AccountChooser",
  accounts: [{ email: "test@gmail.com" }],
};

test("a sign-in dialog the page opened by itself is dismissed, never answered", async () => {
  sent.length = 0;
  await answerDialog(11, one);
  assert.deepEqual(sent, [["FedCm.dismissDialog", { dialogId: "d1" }]]);
  assert.match(takeFedCmNote(11), /by itself/);
});

test("after the agent's click, the only account offered is chosen", async () => {
  sent.length = 0;
  noteAgentClick(12);
  await answerDialog(12, one);
  assert.deepEqual(sent, [["FedCm.selectAccount", { dialogId: "d1", accountIndex: 0 }]]);
  assert.match(takeFedCmNote(12), /test@gmail\.com/);
  assert.equal(takeFedCmNote(12), undefined);
});

test("with several accounts the dialog stays open and the agent is told how to pick", async () => {
  sent.length = 0;
  noteAgentClick(13);
  await answerDialog(13, { ...one, accounts: [{ email: "a@x.com" }, { email: "b@x.com" }] });
  assert.deepEqual(sent, []);
  assert.match(takeFedCmNote(13), /0: a@x\.com, 1: b@x\.com[\s\S]*FedCm\.selectAccount/);
});
