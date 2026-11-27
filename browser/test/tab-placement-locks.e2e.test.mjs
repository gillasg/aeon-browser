// Real Chrome: tabs report their window; a new agent tab follows the chat's tabs to the window
// they were moved to; windowOf opens beside a named tab. A read-only tab refuses clicks and typing
// but still reads and navigates; a tab with allowedOrigins refuses navigation, redirects and link
// clicks to any other origin.
// Run alone, from browser/: node --test test/tab-placement-locks.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { missingChrome, readLine, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

test(
  "agent tabs follow their window, windowOf, readOnly and allowedOrigins",
  { skip: missingChrome() },
  async () => {
    const hits = [];
    const site = createServer((request, response) => {
      hits.push(`${request.headers.host}${request.url}`);
      const port = site.address().port;
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://localhost:${port}/away` });
        response.end();
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>T ${request.url}</title><body>
<input id="field"><button id="btn" onclick="document.title='clicked'">Go</button>
<a id="out" href="http://localhost:${port}/away">out</a></body>`);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${site.address().port}`;
    const chrome = await startBridgeChrome("placement");
    try {
      const placed = await chrome.repl(placementCell(origin));
      const placement = readLine(placed.stdout, "WIN");
      assert.ok(placement, `${placed.stdout}\n${placed.stderr}`);
      assert.notEqual(placement.homeWin, placement.otherWin);
      assert.ok(
        placement.all.every((tab) => Number.isInteger(tab.windowId)),
        "every tab has a windowId",
      );
      assert.equal(placement.anchor, placement.homeWin);
      assert.equal(placement.a, placement.otherWin, "the moved tab is in the other window");
      assert.equal(placement.b, placement.otherWin, "the next tab followed it there");
      assert.equal(placement.c, placement.homeWin, "windowOf opened beside the anchor tab");

      const locked = await chrome.repl(locksCell(origin));
      const locks = readLine(locked.stdout, "LOCKS");
      assert.ok(locks, `${locked.stdout}\n${locked.stderr}`);
      assert.match(locks.click, /TAB_READ_ONLY/);
      assert.match(locks.fill, /TAB_READ_ONLY/);
      assert.equal(locks.readTitle, "T /form", "reads still work and the click never ran");
      assert.equal(locks.navigated, `${origin}/next`, "navigation still works");
      assert.match(locks.offOrigin, /TAB_ORIGIN_BLOCKED/);
      assert.match(locks.openOff, /TAB_ORIGIN_BLOCKED/);
      assert.ok(!locks.afterRedirect.startsWith("http://localhost"), locks.afterRedirect);
      assert.ok(!locks.afterLink.startsWith("http://localhost"), locks.afterLink);
      assert.ok(
        !hits.some((hit) => hit.startsWith("localhost") && hit.endsWith("/away")),
        hits.join(","),
      );
      assert.ok(
        hits.includes(`127.0.0.1:${site.address().port}/redirect`),
        "the redirect itself was requested",
      );
    } finally {
      await chrome.stop();
      site.close();
    }
  },
  240000,
);

function placementCell(origin) {
  const url = (path) => JSON.stringify(`${origin}${path}`);
  return `const id = (page) => page.tabId ?? page.target?.tabId;
const list = async () => (await browser.tabs()).map((t) => ({id: t.target.tabId, url: t.url, windowId: t.windowId}));
const win = (all, page) => all.find((t) => t.id === id(page))?.windowId;
const anchor = await browser.openTab(${url("/anchor")}, {space: 'tabs', newTab: true});
const a = await browser.openTab(${url("/a")}, {space: 'tabs', newTab: true});
// A second window, as the user would have one.
const second = await browser.openTab(${url("/other")}, {window: {width: 900, height: 700}});
const before = await list();
const other = {windowId: win(before, second)};
await browser.moveTab(id(a), {windowId: other.windowId});
const b = await browser.openTab(${url("/b")}, {space: 'tabs', newTab: true});
const c = await browser.openTab(${url("/c")}, {newTab: true, windowOf: id(anchor)});
const all = await list();
console.log('WIN ' + JSON.stringify({homeWin: win(before, a), otherWin: other.windowId, anchor: win(all, anchor), a: win(all, a), b: win(all, b), c: win(all, c), all}));`;
}

function locksCell(origin) {
  const url = (path) => JSON.stringify(`${origin}${path}`);
  return `const fail = async (run) => { try { await run(); return 'ran'; } catch (error) { return String(error && error.message || error); } };
const ro = await browser.openTab(${url("/form")}, {readOnly: true});
const click = await fail(() => ro.click('#btn'));
const fill = await fail(() => ro.fill('#field', 'x'));
const readTitle = await ro.evaluate(() => document.title);
await ro.navigate(${url("/next")});
const navigated = await ro.evaluate(() => location.href);
const g = await browser.openTab(${url("/start")}, {allowedOrigins: [${JSON.stringify(origin)}]});
const offOrigin = await fail(() => g.navigate(${JSON.stringify(origin.replace("127.0.0.1", "localhost"))} + '/away'));
await fail(() => g.navigate(${url("/redirect")}));
const afterRedirect = await g.evaluate(() => location.href).catch(() => 'unreadable');
await g.navigate(${url("/start")});
await fail(() => g.click('#out'));
await new Promise((r) => setTimeout(r, 800));
const afterLink = await g.evaluate(() => location.href).catch(() => 'unreadable');
const openOff = await fail(() => browser.openTab(${JSON.stringify(origin.replace("127.0.0.1", "localhost"))} + '/away', {allowedOrigins: [${JSON.stringify(origin)}]}));
console.log('LOCKS ' + JSON.stringify({click, fill, readTitle, navigated, offOrigin, afterRedirect, afterLink, openOff}));`;
}
