import test from "node:test";
import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture-helper.mjs";
test("scrolling a page with an iframe under the pointer still returns measured feedback", async () => {
  const f = await browserFixture();
  try {
    await f.setPage(
      '<!doctype html><style>body{margin:0}iframe{position:fixed;left:20vw;top:20vh;width:60vw;height:60vh}</style><div style="height:5000px">Page</div><iframe srcdoc="advertisement"></iframe>',
    );
    const result = await f.api.scrollWithFeedback(f.debuggee, {
      step: { op: "scroll", target: { tabId: 1 }, direction: "down", amount: 800 },
    });
    assert.ok(result.moved);
    assert.ok(result.position > 0);
    assert.equal(result.atBoundary, false);
    await f.setPage(
      "<style>body{height:0;margin:0}main{position:absolute;top:0;width:100%;height:1000px}</style><main>Visible content</main>",
    );
    assert.equal(await f.evaluate(`(${f.api.selectorState.toString()})('body','visible')`), true);
  } finally {
    await f.close();
  }
});
