// Chrome launched the way users run it (extension only: no debugging port, no automation flag)
// must look like a person's browser everywhere a site's code can look: the top page, a
// same-origin and a cross-origin iframe, a dedicated worker and a service worker.
// Run alone: node --test test/stealth-launch.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { canLaunch, launchProduct, productArgs } from "./helpers/product-launch.mjs";

// What the site's own code checks, in any realm. Never patches anything.
const PROBE = `function probe(self) {
  const names = Object.getOwnPropertyNames(self).filter((name) => /^(cdc_|\\$cdc_|__playwright|__pw_|__graft|__siteToApi|__ux|__browserkit|__webdriver)/.test(name));
  const native = /\\{\\s*\\[native code\\]\\s*\\}\\s*$/;
  const getter = Object.getOwnPropertyDescriptor(self.Navigator ? self.Navigator.prototype : self.WorkerNavigator.prototype, "webdriver");
  const fns = [self.Function.prototype.toString, self.fetch, getter && getter.get, self.setTimeout].filter(Boolean);
  return {
    webdriver: self.navigator.webdriver === true,
    globals: names,
    nativeToString: fns.every((fn) => native.test(self.Function.prototype.toString.call(fn))),
  };
}`;

const worker = `${PROBE}\npostMessage(probe(self));`;
const serviceWorker = `${PROBE}\nself.addEventListener("message", (event) => event.ports[0].postMessage(probe(self)));`;
const frame = `<!doctype html><script>${PROBE}\nparent.postMessage({frame: location.origin, result: probe(window)}, "*");</script>`;

function page(crossOrigin) {
  return `<!doctype html><title>Shop</title><main><h1>Shop</h1><p>Plain page.</p></main>
<iframe src="/frame"></iframe><iframe src="${crossOrigin}/frame"></iframe>
<script>${PROBE}
window.results = { top: probe(window), frames: [] };
addEventListener("message", (event) => { if (event.data && event.data.frame) results.frames.push(event.data); });
new Worker("/worker.js").onmessage = (event) => { results.worker = event.data; };
navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then((reg) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => { results.serviceWorker = event.data; };
  reg.active.postMessage("probe", [channel.port2]);
});
</script>`;
}

const clean = { webdriver: false, globals: [], nativeToString: true };

test(
  "a product-launched Chrome shows no automation in any realm",
  { skip: !process.env.REQUIRE_E2E && !canLaunch },
  async () => {
    const site = createServer((request, response) => {
      const port = site.address().port;
      const types = { "/worker.js": worker, "/sw.js": serviceWorker };
      if (types[request.url]) {
        response.setHeader("content-type", "text/javascript");
        return response.end(types[request.url]);
      }
      response.setHeader("content-type", "text/html");
      response.end(request.url === "/frame" ? frame : page(`http://localhost:${port}`));
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const args = productArgs("/profile", false);
    assert.equal(
      args.some((arg) => /remote-debugging|enable-automation|headless|pipe/.test(arg)),
      false,
    );
    const product = await launchProduct();
    try {
      const out = await product.repl(`page = await browser.openTab(${JSON.stringify(url)});
for (let i = 0; i < 50; i++) {
  const done = await page.evaluate(() => window.results && results.worker && results.serviceWorker && results.frames.length === 2);
  if (done) break;
  await page.waitForTimeout(200);
}
console.log(JSON.stringify(await page.evaluate(() => ({ results: window.results, html: (() => { const copy = document.documentElement.cloneNode(true); copy.querySelectorAll("script").forEach((node) => node.remove()); return copy.outerHTML; })() }))));`);
      const { results, html } = JSON.parse(
        out
          .trim()
          .split("\n")
          .find((line) => line.startsWith("{")) ?? out,
      );
      assert.deepEqual(results.top, clean, "top page");
      assert.equal(results.frames.length, 2, "both iframes answered");
      for (const item of results.frames) assert.deepEqual(item.result, clean, item.frame);
      assert.deepEqual(results.worker, clean, "dedicated worker");
      assert.deepEqual(results.serviceWorker, clean, "service worker");
      assert.doesNotMatch(html, /graft|aeon|browserkit/i, "the idle page carries a brand name");
    } finally {
      await product.close();
      site.close();
    }
  },
  { timeout: 180_000 },
);
