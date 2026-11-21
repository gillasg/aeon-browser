import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { browserCapabilityApi } from "../dist/code-api-hooks.js";
import { browserFastApi } from "../dist/code-api-page.js";
import { browserPlaywrightApi } from "../dist/code-api-playwright.js";

function load(source) {
  const context = vm.createContext({
    __call: () => Promise.resolve({}),
    console: { warn() {}, log() {}, error() {}, info() {}, debug() {} },
  });
  vm.runInContext(source, context);
  return context;
}

test("page.waitFor({time: 2}) sleeps two seconds and never sends [object Object]", () => {
  const context = load(browserFastApi);
  const waited = vm.runInContext(`__waitInput({time: 2})`, context);
  assert.equal(waited.sleep, 2000);
  assert.equal(waited.expression, undefined);
  assert.equal(JSON.stringify(waited).includes("[object Object]"), false);
  const source = readFileSync(new URL("../src/code-api.ts", import.meta.url), "utf8");
  const line = source.split("\n").find((item) => item.includes("__waitInput"));
  assert.match(line, /sleep\(w\.sleep\)/);
  assert.equal(line.includes("String(fn)"), false);
});

test("a function and a string still wait on a condition, and a bare number sleeps", () => {
  const context = load(browserFastApi);
  const fn = vm.runInContext(`__waitInput(() => document.title, {timeout: 3000})`, context);
  assert.match(fn.expression, /\(\(\) => document\.title\)\(\)/);
  assert.equal(fn.timeoutMs, 3000);
  const text = vm.runInContext(`__waitInput("document.body", 1500)`, context);
  assert.equal(text.expression, "document.body");
  assert.equal(text.timeoutMs, 1500);
  const timed = vm.runInContext(`__waitInput(2500)`, context);
  assert.equal(timed.sleep, 2500);
});

test("an object that is not a wait option throws INVALID_INPUT", () => {
  const context = load(browserFastApi);
  assert.throws(() => vm.runInContext(`__waitInput({selector: "#buy"})`, context), /INVALID_INPUT/);
});

test("an object is not page code for evaluate or a locator read", () => {
  const hooks = load(browserCapabilityApi);
  assert.throws(() => vm.runInContext(`__expression({time: 2})`, hooks), /INVALID_INPUT/);
  const fn = vm.runInContext(`__expression(() => 1)`, hooks);
  assert.match(fn, /\(\(\) => 1\)\(\)/);
  const page = load(browserPlaywrightApi);
  assert.throws(
    () => vm.runInContext(`__locatorRead({}, {}, 0, {time: 2})`, page),
    /INVALID_INPUT/,
  );
});
