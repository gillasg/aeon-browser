// Real Chrome, a local page whose link opens a new tab and whose button calls window.open. The
// click's receipt names the tab it opened (effect "opened_tab", tab {id, url}), so an agent does not
// click again and open a second one. The same page checks the small messages around it: a file://
// URL is refused with what to do instead, page.download(url, {wait: true}) returns the saved path
// once complete, and the download lands in the test profile, not the user's Downloads folder.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { missingChrome, readLine, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const POPUP = `<!doctype html><meta charset="utf-8"><title>Popup</title>
<a id="nt" href="/plain?popup=1" target="_blank">Open help</a>
<button id="wo" onclick="window.open('/plain?wo=1')">Open window</button>`;

test(
  "a click that opens a tab says so; file URLs and downloads answer clearly",
  { skip: missingChrome() },
  async () => {
    const site = createServer((request, response) => {
      if (request.url?.startsWith("/report.csv")) {
        response.setHeader("content-type", "text/csv");
        response.setHeader("content-disposition", 'attachment; filename="report.csv"');
        response.end("a,b\n1,2\n");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        request.url?.startsWith("/plain") ? "<title>Plain</title><p>plain page</p>" : POPUP,
      );
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${site.address().port}`;
    const chrome = await startBridgeChrome("popup-receipt");
    try {
      const out = await chrome.repl(
        `const p = await browser.openTab(${JSON.stringify(base + "/")}, {newTab: true});
const attempt = async (run) => { try { return {ok: true, value: await run()}; } catch (e) { return {ok: false, error: String(e && e.message || e).slice(0, 400)}; } };
const pick = (r) => r && ({effect: r.effect, evidence: r.evidence, tab: r.tab});
const link = pick(await p.click('#nt'));
const opened = pick(await p.click('Open window'));
const file = await attempt(() => browser.openTab('file:///etc/passwd', {newTab: true}));
const saved = await attempt(() => p.download(${JSON.stringify(base + "/report.csv")}, {wait: true}));
console.log("POPUP " + JSON.stringify({link, opened, file, saved}));`,
        120000,
      );
      const result = readLine(out.stdout, "POPUP");
      assert.ok(result, out.stdout + out.stderr);
      const show = JSON.stringify(result);
      for (const click of [result.link, result.opened]) {
        assert.equal(click.effect, "opened_tab", show);
        assert.equal(typeof click.tab?.id, "number", show);
      }
      assert.match(result.link.tab.url, /popup=1/, show);
      assert.equal(result.file.ok, false);
      assert.match(
        result.file.error,
        /^URL_NOT_ALLOWED: file URLs can't be opened; put the file in the workspace/,
      );
      assert.equal(result.saved.ok, true, show);
      assert.equal(result.saved.value.state, "complete", show);
      assert.ok(
        result.saved.value.path.startsWith(chrome.downloads),
        `saved in the test profile (${chrome.downloads}): ${result.saved.value.path}`,
      );
    } finally {
      await chrome.stop();
      site.close();
    }
  },
);
