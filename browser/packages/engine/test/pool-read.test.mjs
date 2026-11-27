import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { browserDataApi } from "../dist/code-api-data.js";
import { browserFastApi } from "../dist/code-api-page.js";
import { browserReadApi } from "../dist/code-api-read.js";

test("a pool publishes each finished value and drops a dead tab", () => {
  assert.match(browserDataApi, /globalThis\.__partialValue = results\.slice\(\)/);
  assert.match(browserDataApi, /function dropTab\(tab\)/);
  assert.match(browserDataApi, /TARGET_LOST\|about:blank\|TAB_DEAD/);
  assert.match(browserDataApi, /tab\.page = undefined/);
});

test("page.read stops after four reads of the same page and honours a short time budget", () => {
  assert.match(browserReadApi, /if \(times > 4\)/);
  assert.match(browserReadApi, /stopped: this page was read/);
  assert.match(browserReadApi, /Math\.max\(500, budget > 0 \? budget : 30000\)/);
  assert.match(browserReadApi, /time budget spent/);
  assert.match(browserFastApi, /__readCounts\.clear\(\)/);
});

test("bu.use binds the page and returns it", async () => {
  const target = {
    clientInstanceId: "c",
    browserRunId: "r",
    tabId: 7,
    tabIncarnation: "i",
  };
  const page = { id: "the-page" };
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    __call: async () => ({}),
    browser: {
      page: () => page,
      tabs: async () => [],
      openTab: async () => page,
    },
  });
  vm.runInContext(browserFastApi, context);
  const key = JSON.stringify(target);
  context.__tabs.set(key, { target, url: "https://example.com/jobs", title: "Jobs" });
  const got = await context.bu.use({ target });
  assert.equal(got, page);
  assert.equal(context.page, page);
  const byId = await context.bu.use("7");
  assert.equal(byId, page);
});
