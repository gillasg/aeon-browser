import assert from "node:assert/strict";
import test from "node:test";
import {
  hideSecrets,
  rememberSecrets,
  scrubError,
  scrubSecrets,
} from "../dist/native-browser-secrets.js";
import {
  documentReplaced,
  guardPageCode,
  prepareSignIn,
  runsPageCode,
} from "../dist/native-browser-password-lock.js";

const target = { tabId: 1, windowId: 1, documentId: "d" };

test("a remembered password is removed from every string agent code gets back, in any encoding", async () => {
  rememberSecrets(["hunter2 secret!"]);
  const result = await scrubSecrets({
    value: "the field holds hunter2 secret!",
    nested: [{ body: "password=hunter2+secret%21&user=a" }],
    json: '{"password":"hunter2 secret!"}',
    base64: btoa("hunter2 secret!"),
    kept: 42,
  });
  assert.equal(result.value, "the field holds [removed]");
  assert.equal(result.nested[0].body, "password=[removed]&user=a");
  assert.equal(result.json, '{"password":"[removed]"}');
  assert.match(result.base64, /^\[removed\]/);
  assert.equal(result.kept, 42);
  assert.equal(hideSecrets("nothing here"), "nothing here");
  const error = await scrubError(new Error("value was hunter2 secret!"));
  assert.equal(error.message, "value was [removed]");
});

test("code that runs in the page is what a password page refuses; clicks and reads are not", () => {
  assert.equal(runsPageCode({ op: "evaluate", target, expression: "1" }), true);
  assert.equal(runsPageCode({ op: "waitFor", target, expression: "1", timeoutMs: 100 }), true);
  assert.equal(runsPageCode({ op: "cdp", target, method: "Runtime.evaluate", params: {} }), true);
  assert.equal(
    runsPageCode({ op: "cdp", target, method: "Page.captureScreenshot", params: {} }),
    false,
  );
  assert.equal(runsPageCode({ op: "frames", target, action: "evaluate", params: {} }), true);
  assert.equal(runsPageCode({ op: "frames", target, action: "click", params: {} }), false);
  assert.equal(runsPageCode({ op: "click", target }), false);
  assert.equal(runsPageCode({ op: "read", target }), false);
});

test(
  "a page that stays silent is brought forward once, then the read is given 10 s",
  { timeout: 20_000 },
  async () => {
    const updates = [];
    const wakes = [];
    globalThis.chrome = {
      storage: { session: { get: async () => ({}), set: async () => undefined } },
      scripting: { executeScript: () => new Promise(() => undefined) },
      webNavigation: {
        getAllFrames: async () => [{ frameId: 0, url: "https://example.test/" }],
      },
      tabs: {
        update: async (id, info) => {
          updates.push({ id, info });
        },
      },
      debugger: {
        sendCommand: async (target, method, params) => {
          wakes.push({ target, method, params });
        },
      },
    };
    const pending = guardPageCode({
      op: "evaluate",
      target,
      expression: "1",
    });
    const error = await pending.then(
      () => {
        throw new Error("resolved");
      },
      (caught) => caught,
    );
    assert.equal(error.message, "TIMEOUT");
    assert.match(error.detail, /within 10 s/);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { id: target.tabId, info: { active: true } });
    assert.equal(wakes.filter((wake) => wake.method === "Page.setWebLifecycleState").length, 1);
  },
);

test("a password the agent did not type stays hidden and the page still runs", async () => {
  const secret = "s3cret-value";
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    scripting: {
      executeScript: async () => [
        {
          frameId: 0,
          result: { password: true, agent: false, filled: true, secrets: [secret] },
        },
      ],
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, url: "https://example.test/login" }],
    },
  };
  await guardPageCode({ op: "evaluate", target, expression: "document.title" });
  await guardPageCode({ op: "cdp", target, method: "Page.getFrameTree", params: {} });
  assert.equal(await prepareSignIn(target.tabId, "https://example.test/login"), undefined);
  const shown = await scrubSecrets(`title Sign in password ${secret}`);
  assert.equal(shown, "title Sign in password [removed]");
});

test("a page replaced mid-check is told apart from one that could not be checked", () => {
  assert.equal(documentReplaced("Frame with ID 0 was removed."), true);
  assert.equal(documentReplaced("no top frame"), true);
  assert.equal(documentReplaced("Cannot access contents of the page"), false);
});
