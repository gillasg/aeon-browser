// Boosts the agent can see, end to end in real Chrome with User Scripts on: save-time warnings,
// a path-scoped boost that starts and stops as a single-page app routes, a live disable that
// takes its widgets back, values that are fresh on the next load, and errors visible in list.
// Real Chrome: CHROME_PATH=<chrome-for-testing 157> CI=1 node --test test/boost-lifecycle.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { userScriptsOn } from "../../../test/helpers/user-scripts-on.mjs";
import { boot, EXT_ID, skipE2e } from "./boost-rig.mjs";

const J = JSON.stringify;

const SPA = `<title>spa</title><h1>spa</h1><script>
window.go = (path) => history.pushState({}, '', path);
</script>`;
// Trusted Types and no inline styles: a page-world innerHTML is refused (a CSP violation).
const TT_CSP =
  "default-src 'self'; script-src 'self' 'nonce-n1'; style-src 'self'; require-trusted-types-for 'script'";

function site() {
  return createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html");
    if (path === "/tt") {
      res.setHeader("content-security-policy", TT_CSP);
      return res.end("<title>tt</title><div id=slot></div>");
    }
    if (path.startsWith("/spa")) return res.end(SPA);
    res.end(`<title>plain</title><h1>plain ${path}</h1>`);
  });
}

const listen = (server, host) =>
  new Promise((done) => server.listen(0, host, () => done(server.address().port)));

/** Browser code: open url, wait, run fn in the page, close the tab unless `keep`. */
function probe(url, fn, wait = 1500) {
  return `const page = await browser.openTab(${J(url)}, {newTab: true});
    await new Promise((r) => setTimeout(r, ${wait}));
    const out = await page.evaluate(${fn});
    await browser.closeTab(page);
    console.log("R " + JSON.stringify(out));`;
}

const save = (rig, boost) =>
  rig.cell(`console.log("R " + JSON.stringify(await browser.boosts.save(${J(boost)})))`);
const removeAll = (rig) =>
  rig.cell(
    `for (const b of await browser.boosts.list()) await browser.boosts.remove(b.id); console.log("R 1")`,
  );
const codes = (saved) => (saved.warnings ?? []).map((w) => w.code);

test(
  "boost lifecycle: warnings, single-page rules, live stop, fresh values, visible errors",
  { skip: skipE2e, timeout: 600_000 },
  async (t) => {
    const a = site();
    const b = site();
    const A = `http://127.0.0.1:${await listen(a, "127.0.0.1")}`;
    const B = `http://localhost:${await listen(b, "127.0.0.1")}`;
    const rig = await boot();
    try {
      assert.equal(await userScriptsOn(rig.browser, EXT_ID), "ok");

      await t.test("save returns warnings for bad js, site rules and selectors", () =>
        saveWarnings(rig),
      );
      await t.test("a page-world boost on a strict-CSP site warns once the site was seen", () =>
        cspWarning(rig, A, B),
      );
      await t.test("a path-scoped boost starts and stops as a single-page app routes", () =>
        singlePage(rig, A, B),
      );
      await t.test(
        "disabling a boost takes its widgets off an open page; enabling puts them back",
        () => liveStop(rig, A, B),
      );
      await t.test("GM_getValue at start reads the latest write, not the registered snapshot", () =>
        freshValues(rig, A, B),
      );
      await t.test("a thrown error shows in boosts.list and boosts.get", () =>
        visibleErrors(rig, A, B),
      );
    } finally {
      await rig.stop();
      a.close();
      b.close();
    }
  },
);

async function saveWarnings(rig) {
  const syntax = await save(rig, { name: "syntax", sites: ["localhost"], js: "function( {" });
  assert.ok(codes(syntax).includes("JS_SYNTAX"), J(syntax));
  const rule = await save(rig, { name: "rule", sites: ["htps://local host"], css: "h1{}" });
  assert.ok(codes(rule).includes("BAD_SITE_RULE"), J(rule));
  const zap = await save(rig, {
    name: "zap",
    sites: ["localhost"],
    zaps: [{ selector: "div[[[" }],
  });
  assert.ok(codes(zap).includes("BAD_SELECTOR"), J(zap));
  const fine = await save(rig, {
    name: "fine",
    sites: ["localhost"],
    css: "h1{color:red}",
    zaps: [{ selector: "h2.x" }],
  });
  assert.deepEqual(fine.warnings, []);
  await removeAll(rig);
}

async function cspWarning(rig, A, B) {
  const boost = {
    name: "tt-page",
    sites: ["localhost"],
    jsWorld: "page",
    js: "try { document.getElementById('slot').innerHTML = '<b>x</b>'; } catch (e) {}",
  };
  const first = await save(rig, boost);
  assert.ok(!codes(first).includes("PAGE_WORLD_STRICT_CSP"), "nothing known yet");
  await rig.cell(probe(`${B}/tt`, "() => 1", 2000));
  const again = await save(rig, { ...boost, id: first.id });
  assert.ok(codes(again).includes("PAGE_WORLD_STRICT_CSP"), J(again));
  assert.match(J(again.warnings), /GM_addElement|isolated/);
  await removeAll(rig);
}

async function singlePage(rig, A, B) {
  await save(rig, {
    name: "deep",
    sites: [{ type: "glob", value: "http://localhost:*/spa/deep*" }],
    js: "document.body.append(Object.assign(document.createElement('i'), {id: 'rt-deep'})); GM.onStop(() => (document.body.dataset.deepStopped = '1'));",
  });
  const seen = await rig.cell(
    probe(
      `${B}/spa`,
      `async () => {
              const has = () => !!document.getElementById('rt-deep');
              const before = has();
              go('/spa/deep/one'); await new Promise((r) => setTimeout(r, 900));
              const inside = has();
              go('/spa/other'); await new Promise((r) => setTimeout(r, 900));
              return {before, inside, after: has(), stopped: document.body.dataset.deepStopped ?? null};
            }`,
    ),
  );
  assert.deepEqual(seen, { before: false, inside: true, after: false, stopped: "1" });
  await removeAll(rig);
}

async function liveStop(rig, A, B) {
  const boost = await save(rig, {
    name: "widget",
    sites: ["localhost"],
    js: `const p = document.createElement('div'); p.id = 'rt-panel'; document.body.append(p);
            GM_addElement(document.body, 'span', {id: 'rt-added'});
            SB.panel({title: 'rt', html: '<b>panel</b>'});
            addEventListener('keydown', () => (document.body.dataset.keys = String(Number(document.body.dataset.keys || 0) + 1)));`,
  });
  const out =
    await rig.cell(`const page = await browser.openTab(${J(B + "/plain")}, {newTab: true});
          await new Promise((r) => setTimeout(r, 1500));
          const count = () => page.evaluate(() => ({
            panel: document.querySelectorAll('#rt-panel').length, added: document.querySelectorAll('#rt-added').length,
            sbPanel: document.querySelectorAll('site-boosts-panel').length }));
          const on = await count();
          await browser.boosts.enable(${J(boost.id)}, false); await new Promise((r) => setTimeout(r, 1200));
          const off = await count();
          await page.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', {key: 'k'})));
          const keysWhileOff = await page.evaluate(() => document.body.dataset.keys ?? '0');
          await browser.boosts.enable(${J(boost.id)}, true); await new Promise((r) => setTimeout(r, 1500));
          const back = await count();
          await page.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', {key: 'k'})));
          const keysBack = await page.evaluate(() => document.body.dataset.keys ?? '0');
          await browser.closeTab(page);
          console.log("R " + JSON.stringify({on, off, back, keysWhileOff, keysBack}));`);
  assert.deepEqual(out.on, { panel: 1, added: 1, sbPanel: 1 }, J(out));
  assert.deepEqual(out.off, { panel: 0, added: 0, sbPanel: 0 }, J(out));
  assert.equal(out.keysWhileOff, "0", "its listener went with it");
  assert.deepEqual(out.back, { panel: 1, added: 1, sbPanel: 1 }, J(out));
  assert.equal(out.keysBack, "1", "one listener again, not two");
  await removeAll(rig);
}

async function freshValues(rig, A, B) {
  await save(rig, {
    name: "values",
    sites: ["localhost", "127.0.0.1"],
    js: `const d = document.documentElement.dataset;
            d.initial = JSON.stringify(GM_getValue('n', null));
            if (location.hostname === '127.0.0.1') { let i = 0; setInterval(() => { GM_setValue('n', ++i); d.wrote = String(i); }, 100); }`,
  });
  const out = await rig.cell(`const w = await browser.openTab(${J(A + "/w")}, {newTab: true});
          await new Promise((r) => setTimeout(r, 2500));
          await browser.closeTab(w);
          await new Promise((r) => setTimeout(r, 300));
          const reader = await browser.openTab(${J(B + "/plain")}, {newTab: true});
          await new Promise((r) => setTimeout(r, 1200));
          const initial = await reader.evaluate(() => JSON.parse(document.documentElement.dataset.initial || 'null'));
          await browser.closeTab(reader);
          console.log("R " + JSON.stringify({initial}));`);
  // Writes every 100 ms for ~2 s: the snapshot sync could never keep up; the fresh read does.
  assert.ok(Number(out.initial) >= 10, J(out));
  await removeAll(rig);
}

async function visibleErrors(rig, A, B) {
  const bad = await save(rig, {
    name: "throws",
    sites: ["localhost"],
    js: "nope.undefinedThing()",
  });
  const out =
    await rig.cell(`const page = await browser.openTab(${J(B + "/plain")}, {newTab: true});
          await new Promise((r) => setTimeout(r, 1800));
          const list = await browser.boosts.list(${J(B + "/plain")});
          const got = await browser.boosts.get(${J(bad.id)});
          await browser.closeTab(page);
          console.log("R " + JSON.stringify({list, got: {lastError: got.lastError, lastRun: got.lastRun, tabs: got.tabs}}));`);
  const entry = out.list.find((item) => item.id === bad.id);
  assert.match(entry.lastError.message, /nope is not defined/);
  assert.match(String(entry.lastError.stack), /nope|at /);
  assert.match(out.got.lastRun.url, /\/plain$/);
  assert.equal(out.got.tabs.length, 1, "running in the one open tab");
  await removeAll(rig);
}
