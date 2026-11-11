// S5 call sites: a fake debuggee that never answers the chosen method still settles, and the
// record names the function. Eval passes the caller's 5s (or the caller's own timeout).
import assert from "node:assert/strict";
import test from "node:test";

const pending = [];
const calls = [];
let hang = () => false;
let seq = 5_000;

function sendCommand(debuggee, method, params) {
  calls.push({ method, params, debuggee });
  if (hang(method, params, debuggee)) return new Promise((resolve) => pending.push(resolve));
  return Promise.resolve(reply(method, params));
}

function reply(method, params) {
  const text = String(params?.expression ?? "");
  if (method === "Runtime.evaluate") return { result: { value: evaluateValue(text) } };
  if (method === "Page.getFrameTree")
    return {
      frameTree: { frame: { id: "frame", url: "https://example.test/", loaderId: "load" } },
    };
  if (method === "Page.createIsolatedWorld") return { executionContextId: 3 };
  if (method === "DOM.resolveNode") return { object: { objectId: "obj" } };
  if (method === "Runtime.callFunctionOn")
    return {
      result: {
        value: {
          url: "https://example.test/",
          site: "example.test",
          hasPassword: true,
          password: "secret",
          username: "ada",
          signup: false,
        },
      },
    };
  if (method === "DOM.getBoxModel") return { model: { border: [0, 0, 10, 0, 10, 8, 0, 8] } };
  return {};
}

function evaluateValue(text) {
  if (text.includes('="submit"')) return false;
  if (text.includes("scrollIntoView")) return { x: 8, y: 9 };
  if (text.includes("codeBoxes"))
    return {
      user: true,
      userValue: "",
      password: false,
      code: false,
      submit: false,
      captcha: false,
      url: "https://example.test/",
      autofill: false,
    };
  if (text.includes("hasPassword"))
    return {
      url: "https://example.test/",
      site: "example.test",
      hasPassword: false,
      password: "",
      username: "",
      signup: false,
    };
  if (text.includes("aeon.handoff")) return "waiting";
  return true;
}

function events() {
  return {
    addListener() {},
    removeListener() {},
    hasListener() {
      return false;
    },
  };
}

function bag() {
  const fn = () => Promise.resolve(undefined);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "addListener" || prop === "removeListener" || prop === "hasListener")
        return () => {};
      return bag();
    },
    apply() {
      return Promise.resolve(undefined);
    },
  });
}

const chrome = {
  debugger: {
    sendCommand,
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onEvent: events(),
    onDetach: events(),
  },
  tabs: {
    get: async (id) => ({
      id,
      active: true,
      discarded: false,
      status: "complete",
      windowId: 1,
      url: "https://example.test/",
    }),
    update: async () => undefined,
    reload: async () => undefined,
    query: async () => [],
    create: async () => ({ id: 1, windowId: 1 }),
    onRemoved: events(),
    onActivated: events(),
    onReplaced: events(),
    onUpdated: events(),
    onCreated: events(),
    onAttached: events(),
  },
  windows: {
    get: async () => ({ id: 1, focused: true, state: "normal" }),
    update: async () => undefined,
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  storage: {
    session: { get: async () => ({}), set: async () => undefined },
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    onChanged: events(),
  },
  runtime: {
    id: "ext",
    getURL: () => "icon.png",
    sendMessage: async () => undefined,
    onMessage: events(),
    onInstalled: events(),
    onStartup: events(),
    onUserScriptMessage: events(),
  },
  notifications: {
    create: async () => undefined,
    clear: async () => undefined,
    onClicked: events(),
  },
  webNavigation: {
    onDOMContentLoaded: {
      addListener(fn) {
        queueMicrotask(() => fn({ tabId: seq, frameId: 0 }));
      },
      removeListener() {},
    },
    onCommitted: events(),
    onErrorOccurred: events(),
    onHistoryStateUpdated: events(),
    onReferenceFragmentUpdated: events(),
    getAllFrames: async () => [{ frameId: 0, url: "https://example.test/" }],
  },
  scripting: {
    executeScript: async () => [
      { frameId: 0, result: { password: false, agent: true, filled: false } },
    ],
  },
  userScripts: {
    getScripts: async () => [],
    execute: async () => [],
    configureWorld: async () => undefined,
  },
  declarativeNetRequest: { updateSessionRules: async () => undefined },
  downloads: { onCreated: events() },
  permissions: { contains: async () => true, onAdded: events(), onRemoved: events() },
  alarms: { create() {}, onAlarm: events() },
};

globalThis.chrome = new Proxy(chrome, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
    return bag();
  },
});

const { callLimitMs, recent } = await import("../dist/cdp/send.js");
const { configureEngine, engineConfig } = await import("../dist/engine-config.js");
const session = await import("../dist/native-browser-session.js");
const signin = await import("../dist/native-browser-signin-page.js");
const chromeSignin = await import("../dist/native-browser-signin-chrome.js");
const vault = await import("../dist/native-browser-vault.js");
const handoff = await import("../dist/native-browser-handoff.js");
const fedcm = await import("../dist/native-browser-fedcm.js");
const scripts = await import("../dist/site-script-runtime.js");
const dialogs = await import("../dist/evidence/dialogs.js");
const quiet = await import("../dist/native-browser-quiet.js");
const lock = await import("../dist/native-browser-password-lock.js");
const scopes = await import("../dist/native-browser-network-scopes.js");
const timing = await import("../dist/native-browser-action-timing.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");

configureEngine({
  agentGlow: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(true),
});
engineConfig.cdpLimitFactor = 0.02;

const MARGIN = 2_500;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const script = {
  scriptId: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  name: "preview",
  matches: ["https://example.test/*"],
  code: "1",
  css: "",
  enabled: false,
};

function release() {
  hang = () => false;
  for (const resolve of pending.splice(0)) resolve({});
}

async function finish() {
  release();
  await pause(20);
  await session.releaseBrowserSessions("chat").catch(() => undefined);
}

function named(error, label) {
  const text = String(error instanceof Error ? error.message : error);
  assert.match(text, new RegExp(`\\(${label}\\)`), text);
  assert.match(text, /did not answer/, text);
}

function failure(label) {
  return [...recent()]
    .reverse()
    .find((row) => row.label === label && row.ok === false && /did not answer/.test(row.err ?? ""));
}

async function waitFailure(label, limit) {
  const cap = limit + MARGIN;
  const started = Date.now();
  let row;
  while (Date.now() - started <= cap) {
    row = failure(label);
    if (row?.err?.includes("did not answer")) break;
    await pause(15);
  }
  assert.ok(row, label);
  assert.match(row.err ?? "", /did not answer/);
  assert.match(row.err ?? "", new RegExp(`\\(${label}\\)`));
  assert.ok(Date.now() - started <= cap + 200);
}

async function settled(limit, run) {
  const cap = limit + MARGIN;
  const started = Date.now();
  let status = "hung";
  await Promise.race([
    Promise.resolve()
      .then(run)
      .then(
        () => {
          status = "settled";
        },
        () => {
          status = "settled";
        },
      ),
    pause(cap).then(() => {
      status = "hung";
    }),
  ]);
  assert.equal(status, "settled");
  assert.ok(Date.now() - started <= cap + 200);
}

test.after(async () => {
  await finish();
});

test("sign-in typing, submit and evaluate name the call when the page never answers", async () => {
  const read = callLimitMs("Runtime.evaluate", 5_000);
  const input = callLimitMs("Input.dispatchKeyEvent");
  const tab = ++seq;
  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Runtime.evaluate";
  let caught;
  await settled(read, async () => {
    try {
      await signin.evaluate(tab, "1");
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "evaluate");
  const evalCall = calls.filter((item) => item.method === "Runtime.evaluate").at(-1);
  assert.equal(evalCall.params.timeout, 5_000);
  await finish();

  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Input.dispatchKeyEvent";
  caught = undefined;
  await settled(input, async () => {
    try {
      await signin.typeInto(tab, "user", "ada");
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "typeInto");
  await finish();

  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Input.dispatchKeyEvent";
  caught = undefined;
  await settled(input, async () => {
    try {
      await signin.submitForm(tab);
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "submitForm");
  await finish();
});

test("Chrome's saved-login click and keypress name the call", async () => {
  const fields = {
    user: true,
    userValue: "",
    password: false,
    code: false,
    submit: false,
    captcha: false,
    url: "https://example.test/",
  };
  const tab = ++seq;
  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Input.dispatchMouseEvent";
  let caught;
  await settled(callLimitMs("Input.dispatchMouseEvent"), async () => {
    try {
      await chromeSignin.chromeFill(tab, fields);
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "clickAt");
  await finish();

  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Input.dispatchKeyEvent";
  caught = undefined;
  await settled(callLimitMs("Input.dispatchKeyEvent"), async () => {
    try {
      await chromeSignin.chromeFill(tab, fields);
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "press");
  await finish();
});

test("vault probe and the password-field blur name the call", async () => {
  const tab = ++seq;
  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Runtime.evaluate";
  let caught;
  await settled(callLimitMs("Runtime.evaluate", 5_000), async () => {
    try {
      await vault.probeVaultForm(tab);
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "probeVaultForm");
  assert.equal(
    calls.filter((item) => item.method === "Runtime.evaluate").at(-1).params.timeout,
    5_000,
  );
  await finish();

  hang = (method) => method === "Runtime.evaluate";
  const before = calls.length;
  await settled(callLimitMs("Runtime.evaluate", 1_000), () =>
    vault.noteVaultFill({ tabId: ++seq }, 4),
  );
  const row = failure("dismissPasswordUi");
  assert.match(row?.err ?? "", /dismissPasswordUi/);
  assert.match(row?.err ?? "", /did not answer/);
  assert.equal(
    calls.slice(before).some((item) => item.method === "Input.dispatchKeyEvent"),
    false,
  );
  await finish();
});

test("hand-off's page read names the call and the poll still ends", async () => {
  const tab = ++seq;
  session.bindBrowserSession(tab, "chat");
  let evals = 0;
  hang = (method) => {
    if (method !== "Runtime.evaluate") return false;
    evals += 1;
    return evals > 1;
  };
  let ticks = 0;
  await settled(callLimitMs("Runtime.evaluate", 5_000) + 800, () =>
    handoff.handOffToUser(tab, "sign in", () => ++ticks < 2),
  );
  const row = failure("evaluate");
  assert.match(row?.err ?? "", /evaluate/);
  assert.match(row?.err ?? "", /did not answer/);
  await finish();
});

test("a FedCM answer that never returns is swallowed and named", async () => {
  hang = (method) => method === "FedCm.dismissDialog";
  await settled(callLimitMs("FedCm.dismissDialog"), () =>
    fedcm.answerDialog(++seq, { dialogId: "d", dialogType: "AutoReauthn", accounts: [] }),
  );
  const row = failure("answerDialog");
  assert.match(row?.err ?? "", /answerDialog/);
  assert.match(row?.err ?? "", /did not answer/);
  await finish();
});

test("site-script preview and removal name the call", async () => {
  const tab = ++seq;
  session.bindBrowserSession(tab, "chat");
  hang = (method) => method === "Runtime.evaluate";
  let caught;
  await settled(callLimitMs("Runtime.evaluate", 5_000), async () => {
    try {
      await scripts.previewSiteScript(tab, script, async () => undefined);
    } catch (error) {
      caught = error;
    }
  });
  named(caught, "previewSiteScript");
  assert.equal(
    calls.filter((item) => item.method === "Runtime.evaluate").at(-1).params.timeout,
    5_000,
  );
  await finish();

  const kept = ++seq;
  session.bindBrowserSession(kept, "chat");
  hang = () => false;
  await scripts.previewSiteScript(kept, script, async () => undefined);
  hang = (method) => method === "Runtime.evaluate";
  const removed = await scripts.removeScriptPreview(kept, script.scriptId);
  assert.equal(removed, true);
  await waitFailure("removeScriptPreview", callLimitMs("Runtime.evaluate", 5_000));
  await finish();
});

test("a dialog answer, a child network session and a box measure name the call", async () => {
  hang = (method) => method === "Page.handleJavaScriptDialog";
  dialogs.onJavaScriptDialog({ tabId: ++seq }, "Page.javascriptDialogOpening", {
    type: "alert",
    message: "hi",
  });
  await waitFailure("onJavaScriptDialog", callLimitMs("Page.handleJavaScriptDialog"));
  await finish();

  hang = (method) => method === "Network.enable";
  scopes.attachChild(++seq, {
    sessionId: "child",
    targetInfo: { type: "worker", url: "https://example.test/w.js" },
  });
  await waitFailure("attachChild", callLimitMs("Network.enable"));
  await finish();

  hang = (method) => method === "DOM.getBoxModel";
  const box = await timing.measureBox({ tabId: ++seq }, 9);
  assert.equal(box, undefined);
  await waitFailure("measureBox", callLimitMs("DOM.getBoxModel"));
  await finish();
});

test("a planted script removal and a quiet attach name the call", async () => {
  const tab = ++seq;
  session.bindBrowserSession(tab, "chat");
  lock.notePlantedScript(tab, { identifier: "plant-1" });
  hang = (method) => method === "Page.removeScriptToEvaluateOnNewDocument";
  await settled(callLimitMs("Page.removeScriptToEvaluateOnNewDocument"), () =>
    lock.prepareSignIn(tab, "https://example.test/login"),
  );
  const row = failure("removePlanted");
  assert.match(row?.err ?? "", /removePlanted/);
  assert.match(row?.err ?? "", /did not answer/);
  await finish();

  installEngineListeners();
  const quietTab = ++seq;
  session.bindBrowserSession(quietTab, "chat");
  await quiet.enableQuietTab(quietTab, { ads: true });
  hang = (method) => method === "Page.addScriptToEvaluateOnNewDocument";
  await settled(callLimitMs("Page.addScriptToEvaluateOnNewDocument"), () =>
    session.ensureBrowserAttachment(quietTab, "chat"),
  );
  const quietRow = failure("onQuietAttach");
  assert.match(quietRow?.err ?? "", /onQuietAttach/);
  assert.match(quietRow?.err ?? "", /did not answer/);
  await finish();
});

test("a quiet tab without ads still installs the media hook, and ads still blocks window.open", async () => {
  installEngineListeners();
  hang = () => false;
  const plain = ++seq;
  session.bindBrowserSession(plain, "chat");
  await quiet.enableQuietTab(plain);
  const before = calls.length;
  await session.ensureBrowserAttachment(plain, "chat");
  const media = calls
    .slice(before)
    .find((item) => item.method === "Page.addScriptToEvaluateOnNewDocument");
  assert.ok(
    media,
    calls
      .slice(before)
      .map((item) => item.method)
      .join(","),
  );
  assert.match(media.params.source, /HTMLMediaElement\.prototype\.play/);
  assert.match(media.params.source, /this\.muted = true/);
  assert.doesNotMatch(media.params.source, /window\.open/);
  await session.releaseBrowserSessions("chat").catch(() => undefined);

  const filtered = ++seq;
  session.bindBrowserSession(filtered, "chat");
  await quiet.enableQuietTab(filtered, { ads: true });
  const adsBefore = calls.length;
  await session.ensureBrowserAttachment(filtered, "chat");
  const full = calls
    .slice(adsBefore)
    .find((item) => item.method === "Page.addScriptToEvaluateOnNewDocument");
  assert.ok(full);
  assert.match(full.params.source, /window\.open/);
  assert.match(full.params.source, /HTMLMediaElement\.prototype\.play/);
  await session.releaseBrowserSessions("chat").catch(() => undefined);
});
