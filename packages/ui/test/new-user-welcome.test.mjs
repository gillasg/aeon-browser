import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NewUserWelcome,
  WELCOME_DONE_EVENT,
  markWelcomeDone,
  resetWelcome,
} from "../dist/new-user-welcome.js";
import { ReadinessStrip } from "../dist/readiness-strip.js";
import { shortcutLabel } from "../dist/platform.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const render = () =>
  renderToStaticMarkup(createElement(NewUserWelcome, { needsModel: false, onExample() {} }));

test("the welcome shows until a task is sent, then stays gone until Settings resets it", () => {
  store.clear();
  assert.match(render(), /Welcome to Aeon/);
  markWelcomeDone();
  assert.equal(render(), "");
  resetWelcome();
  assert.match(render(), /Welcome to Aeon/);
});

test("sending any task hides an open welcome at once, not only an example pick", () => {
  store.clear();
  let fired = 0;
  const listener = () => fired++;
  const target = (globalThis.window ??= new globalThis.EventTarget());
  target.addEventListener(WELCOME_DONE_EVENT, listener);
  markWelcomeDone();
  target.removeEventListener(WELCOME_DONE_EVENT, listener);
  assert.equal(fired, 1);
  assert.equal(render(), "");
  resetWelcome();
});

test("the readiness strip shows only what needs the user, with a copyable relaunch command", () => {
  store.clear();
  const strip = (props) =>
    renderToStaticMarkup(createElement(ReadinessStrip, { platform: "Linux x86_64", ...props }));
  assert.equal(strip({ connected: true }), "");
  assert.equal(strip({ connected: true, missingChromeFlags: [] }), "");
  const flags = strip({
    connected: true,
    missingChromeFlags: ["--silent-debugger-extension-api"],
    platform: "macOS",
  });
  assert.match(flags, /open -na &quot;Google Chrome&quot; --args --silent-debugger-extension-api/);
  assert.match(flags, /Dismiss/);
  store.set("aeonFlagsNoticeDismissed", "--silent-debugger-extension-api");
  assert.equal(
    strip({ connected: true, missingChromeFlags: ["--silent-debugger-extension-api"] }),
    "",
  );
  assert.match(strip({ connected: false, offlineDelayMs: 0 }), /aeon doctor/);
  assert.equal(strip({ connected: false }), "");
});

test("shortcut labels follow the OS", () => {
  assert.equal(shortcutLabel("MacIntel"), "⌥⇧Space");
  assert.equal(shortcutLabel("darwin"), "⌥⇧Space");
  assert.equal(shortcutLabel("Win32"), "Alt+Shift+Space");
  assert.equal(shortcutLabel("Linux x86_64"), "Alt+Shift+Space");
});
