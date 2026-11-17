import assert from "node:assert/strict";
import test from "node:test";

const sent = [];
const eventListeners = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_target, method, params) => sent.push([method, params]),
    onEvent: {
      addListener(listener) {
        eventListeners.push(listener);
      },
    },
  },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
};
const { answerDialog, ensureFedCm, fedcmEnabled, noteAgentClick, takeFedCmNote } =
  await import("../dist/native-browser-fedcm.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");

const one = {
  dialogId: "d1",
  dialogType: "AccountChooser",
  accounts: [{ email: "test@gmail.com" }],
};

test("a fired FedCm.dialogShown event reaches the CDP answer through the real listener", async () => {
  installEngineListeners();
  assert.ok(eventListeners.length >= 1);
  const tab = 99;
  noteAgentClick(tab);
  await ensureFedCm(tab);
  sent.length = 0;
  for (const listener of eventListeners)
    listener({ tabId: tab }, "FedCm.dialogShown", { ...one, dialogId: "d2" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(sent, [["FedCm.selectAccount", { dialogId: "d2", accountIndex: 0 }]]);
  assert.match(takeFedCmNote(tab), /test@gmail\.com/);
});

test("a sign-in dialog the page opened by itself is dismissed, never answered", async () => {
  sent.length = 0;
  await answerDialog(11, one);
  assert.deepEqual(sent, [["FedCm.dismissDialog", { dialogId: "d1" }]]);
  assert.match(takeFedCmNote(11), /by itself/);
});

test("after the agent's click, the only account offered is chosen", async () => {
  sent.length = 0;
  noteAgentClick(12);
  await new Promise((done) => setImmediate(done));
  assert.equal(
    sent.some(([method]) => method === "FedCm.enable"),
    false,
  );
  await ensureFedCm(12);
  assert.equal(sent[0]?.[0], "FedCm.enable");
  sent.length = 0;
  await answerDialog(12, one);
  assert.deepEqual(sent, [["FedCm.selectAccount", { dialogId: "d1", accountIndex: 0 }]]);
  assert.match(takeFedCmNote(12), /test@gmail\.com/);
  assert.equal(takeFedCmNote(12), undefined);
});

test("with several accounts the dialog stays open and the agent is told how to pick", async () => {
  sent.length = 0;
  noteAgentClick(13);
  await ensureFedCm(13);
  sent.length = 0;
  await answerDialog(13, { ...one, accounts: [{ email: "a@x.com" }, { email: "b@x.com" }] });
  assert.deepEqual(sent, []);
  assert.match(takeFedCmNote(13), /0: a@x\.com, 1: b@x\.com[\s\S]*FedCm\.selectAccount/);
});

test("a failed FedCM enable is not remembered, so the next call retries", async () => {
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async () => {
    throw new Error("nope");
  };
  noteAgentClick(20);
  await ensureFedCm(20);
  assert.equal(fedcmEnabled(20), false);
  const retried = [];
  chrome.debugger.sendCommand = async (_target, method, params) => {
    retried.push([method, params]);
  };
  await ensureFedCm(20);
  assert.equal(retried[0]?.[0], "FedCm.enable");
  assert.equal(fedcmEnabled(20), true);
  chrome.debugger.sendCommand = original;
});
