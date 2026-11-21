import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { browserPlaywrightApi } from "../dist/code-api-playwright.js";
import { HELP_TOPICS } from "../dist/code-api-help.js";

function load() {
  const warnings = [];
  const context = vm.createContext({
    console: {
      warn: (line) => warnings.push(String(line)),
      log() {},
      error() {},
      info() {},
      debug() {},
    },
  });
  vm.runInContext(browserPlaywrightApi, context);
  return { context, warnings };
}

test("waitForLoad warns when the DOM is interactive and the load never finishes", async () => {
  const { context, warnings } = load();
  const value = await vm.runInContext(
    `(async () => __waitForLoad({
      waitFor: async () => { throw new Error("TIMEOUT: load"); },
      evaluate: async () => "interactive",
    }, { timeout: 8000 }))()`,
    context,
  );
  assert.equal(JSON.stringify(value), JSON.stringify({ readyState: "interactive" }));
  assert.equal(
    JSON.stringify(warnings),
    JSON.stringify(["[warn] load still pending after 8 s; DOM ready"]),
  );
});

test("waitForLoad still throws when the DOM is not interactive", async () => {
  const { context } = load();
  await assert.rejects(
    () =>
      vm.runInContext(
        `(async () => __waitForLoad({
          waitFor: async () => { throw new Error("TIMEOUT: load"); },
          evaluate: async () => "loading",
        }))()`,
        context,
      ),
    /TIMEOUT: load/,
  );
});

test("waitForLoad still throws on a non-timeout failure", async () => {
  const { context, warnings } = load();
  await assert.rejects(
    () =>
      vm.runInContext(
        `(async () => __waitForLoad({
          waitFor: async () => { throw new Error("TARGET_LOST"); },
          evaluate: async () => "interactive",
        }))()`,
        context,
      ),
    /TARGET_LOST/,
  );
  assert.equal(warnings.length, 0);
});

test("waitForLoad returns the load result when the page reaches complete", async () => {
  const { context, warnings } = load();
  const value = await vm.runInContext(
    `(async () => __waitForLoad({
      waitFor: async () => ({ readyState: "complete" }),
      evaluate: async () => { throw new Error("should not read readyState"); },
    }))()`,
    context,
  );
  assert.equal(JSON.stringify(value), JSON.stringify({ readyState: "complete" }));
  assert.equal(warnings.length, 0);
});

test("waitForLoad rethrows the timeout when readyState itself cannot be read", async () => {
  const { context } = load();
  await assert.rejects(
    () =>
      vm.runInContext(
        `(async () => __waitForLoad({
          waitFor: async () => { throw new Error("TIMEOUT: load"); },
          evaluate: async () => { throw new Error("context destroyed"); },
        }))()`,
        context,
      ),
    /TIMEOUT: load/,
  );
});

test("waitForLoadState stays a strict Playwright wait", () => {
  const source = readFileSync(new URL("../src/code-api-playwright.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /waitForLoadState: \(state, options = \{\}\) => base\.waitFor\(state === 'domcontentloaded'/,
  );
  assert.match(source, /waitForLoad: \(options\) => __waitForLoad\(base, options\)/);
  assert.match(HELP_TOPICS.playwright, /sleep\(ms\) \(at most 60s\)/);
  assert.match(HELP_TOPICS.playwright, /waitForLoad\(\) \(warns instead of failing/);
  assert.match(HELP_TOPICS.screenshot, /captureSequence/);
  assert.match(HELP_TOPICS.screenshot, /screens\//);
});
