import assert from "node:assert/strict";
import test from "node:test";

const sent = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_source, method, params) => sent.push([method, params]),
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async () => ({ url: "https://example.test/page" }),
    onRemoved: { addListener() {} },
  },
  downloads: { onCreated: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
};

const {
  DIALOG_ACT_MS,
  answerDialogOpening,
  expectNextDialog,
  noteAgentNavigation,
  noteDialogAct,
  onJavaScriptDialog,
  takeDialogWarns,
  withDialogWarn,
} = await import("../dist/evidence/dialogs.js");
const { beginReceipt, takeReceipt } = await import("../dist/native-browser-receipts.js");
const { browserCodeApi } = await import("../dist/code-api.js");
const { browserFastApi } = await import("../dist/code-api-page.js");

test("an alert is accepted whether or not the agent just acted", () => {
  const alone = answerDialogOpening(1, { type: "alert", message: "hi" }, 10_000, false);
  assert.equal(alone.accept, true);
  assert.equal(alone.warn, undefined);
  assert.equal(alone.line, "[dialog alert] hi (accepted)");
  noteDialogAct(2, 0);
  const after = answerDialogOpening(2, { type: "alert", message: "hi" }, 10, true);
  assert.equal(after.accept, true);
});

test("a confirm or prompt just after an action is accepted, and a prompt keeps its default text", () => {
  noteDialogAct(3, 1_000);
  const confirm = answerDialogOpening(
    3,
    { type: "confirm", message: "sure" },
    1_000 + DIALOG_ACT_MS - 1,
    true,
  );
  assert.equal(confirm.accept, true);
  assert.equal(confirm.message, "sure");
  assert.equal(confirm.warn, undefined);
  noteDialogAct(4, 1_000);
  const prompt = answerDialogOpening(
    4,
    { type: "prompt", message: "name", defaultPrompt: "ada" },
    2_000,
    true,
  );
  assert.equal(prompt.accept, true);
  assert.equal(prompt.promptText, "ada");
  assert.equal(prompt.type, "prompt");
});

test("a confirm the page opens on its own is dismissed and the warn names page.dialog.expect", () => {
  noteDialogAct(5, 0);
  const decision = answerDialogOpening(
    5,
    { type: "confirm", message: "on its own" },
    DIALOG_ACT_MS,
    false,
  );
  assert.equal(decision.accept, false);
  assert.match(decision.warn ?? "", /on its own/);
  assert.match(decision.warn ?? "", /page\.dialog\.expect\("accept"\)/);
  assert.match(takeDialogWarns(5) ?? "", /\[warn\]/);
  assert.equal(takeDialogWarns(5), undefined);
});

test("beforeunload is accepted only for an agent navigation in a tab the agent opened", () => {
  noteAgentNavigation(6, 1_000);
  const left = answerDialogOpening(6, { type: "beforeunload", message: "leave" }, 1_200, true);
  assert.equal(left.accept, true);
  assert.equal(left.warn, undefined);
  noteAgentNavigation(7, 1_000);
  const users = answerDialogOpening(7, { type: "beforeunload", message: "leave" }, 1_200, false);
  assert.equal(users.accept, false);
  assert.match(users.warn ?? "", /user's tab/);
  assert.match(users.warn ?? "", /page\.dialog\.expect\("accept"\)/);
  noteAgentNavigation(8, 1_000);
  const stale = answerDialogOpening(
    8,
    { type: "beforeunload", message: "leave" },
    1_000 + 1_500,
    true,
  );
  assert.equal(stale.accept, false);
});

test("page.dialog.expect answers the next dialog once, then the rule applies again", () => {
  noteDialogAct(9, 1_000);
  expectNextDialog(9, "dismiss");
  const dismissed = answerDialogOpening(9, { type: "confirm", message: "sure" }, 2_000, true);
  assert.equal(dismissed.accept, false);
  assert.equal(dismissed.warn, undefined);
  const again = answerDialogOpening(9, { type: "confirm", message: "sure" }, 2_000, true);
  assert.equal(again.accept, true);
  expectNextDialog(10, "typed");
  const prompt = answerDialogOpening(
    10,
    { type: "prompt", message: "name", defaultPrompt: "ada" },
    1,
    false,
  );
  assert.equal(prompt.accept, true);
  assert.equal(prompt.promptText, "typed");
  expectNextDialog(11, "accept");
  const accepted = answerDialogOpening(
    11,
    { type: "prompt", message: "name", defaultPrompt: "ada" },
    1,
    false,
  );
  assert.equal(accepted.promptText, "ada");
  expectNextDialog(12, "dismiss");
  const alert = answerDialogOpening(12, { type: "alert", message: "hi" }, 1, false);
  assert.equal(alert.accept, false);
});

test("a dialog during an action is on the receipt, and a refusal is a [warn] on the step", () => {
  beginReceipt(13);
  answerDialogOpening(13, { type: "alert", message: "hello alert" }, 1, true);
  assert.deepEqual(takeReceipt(13).dialog, {
    type: "alert",
    message: "hello alert",
    accepted: true,
  });
  answerDialogOpening(14, { type: "confirm", message: "solo" }, 1, false);
  const action = withDialogWarn(
    {
      kind: "action",
      target: {
        tabId: 14,
        tabIncarnation: "t",
        clientInstanceId: "00000000-0000-4000-8000-000000000001",
      },
      documentEpoch: 0,
      url: "https://example.test/",
      effect: "confirmed",
      evidence: "dialog",
      note: "kept",
    },
    14,
  );
  assert.match(action.note ?? "", /^\[warn\]/);
  assert.match(action.note ?? "", /solo/);
  assert.match(action.note ?? "", /kept/);
});

test("the listener answers the dialog at once and ignores other events", () => {
  sent.length = 0;
  onJavaScriptDialog({ tabId: 15 }, "Page.javascriptDialogOpening", {
    type: "confirm",
    message: "nope",
  });
  assert.deepEqual(sent, [["Page.handleJavaScriptDialog", { accept: false, promptText: "" }]]);
  onJavaScriptDialog({ tabId: 15 }, "Page.loadEventFired", {});
  assert.equal(sent.length, 1);
});

test("the page API exposes page.dialog.expect and prints [warn] lines", () => {
  assert.match(browserCodeApi, /op:'dialog'/);
  assert.match(browserCodeApi, /page\.dialog\.expect/);
  assert.match(browserFastApi, /function __logDialogWarn/);
});
