import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewUserWelcome, markWelcomeDone, resetWelcome } from "../dist/new-user-welcome.js";

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
