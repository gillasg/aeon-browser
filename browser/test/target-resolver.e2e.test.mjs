// Real Chrome, two local origins (127.0.0.1 and localhost, so the widget frame is cross-origin).
// One way to name a target: an exact unique visible name clicks, a shared name fails
// TARGET_AMBIGUOUS with each ref, a frame ref types and fills (never reaching CSS), a miss inside a
// frame names the closest control, role and label locators reach a closed shadow root, and
// read().text carries each frame's text under its own [frame: ...] line.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { missingChrome, readLine, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const page = (widget) => `<!doctype html><meta charset="utf-8"><title>Targets</title>
<h1>Targets</h1>
<button onclick="document.title='loaded'">Load details</button>
<button onclick="this.dataset.n='1'">Save</button><button onclick="this.dataset.n='2'">Save</button>
<x-closed></x-closed>
<iframe id="xo" src="${widget}" width="400" height="200"></iframe>
<script>
customElements.define("x-closed", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<button>Closed secret</button><input aria-label="Closed field">';
    window._closed = root;
    root.querySelector("button").onclick = () => { window.closedClicked = true; };
  }
});
</script>`;

const WIDGET = `<!doctype html><meta charset="utf-8"><title>Pay widget</title>
<p>XO_WIDGET_TEXT</p><label>Card number <input id="card"></label>
<button onclick="this.textContent='Paid'">Pay now</button>`;

function serve(body) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(body());
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const CELL = (url) => `
const p = await browser.openTab(${JSON.stringify(url)}, {newTab: true});
await p.waitForLoadState('load').catch(() => {});
const attempt = async (run) => { try { return {ok: true, value: await run()}; } catch (e) { return {ok: false, error: String(e && e.message || e).slice(0, 600)}; } };
const state = String(await p.state());
const card = /\\[(f\\d+:e\\d+)\\][^\\n]*"Card number"/.exec(state)?.[1];
const pay = /\\[(f\\d+:e\\d+)\\][^\\n]*"Pay now"/.exec(state)?.[1];
const byName = await attempt(() => p.click("Load details"));
const shared = await attempt(() => p.click("Save"));
const typed = await attempt(() => p.type(card, "4242"));
const located = await attempt(() => p.locator(card).fill("4242424242424242"));
const paid = await attempt(() => p.click(pay));
const miss = await attempt(() => p.click("Card numbr"));
const closedClick = await attempt(() => p.getByRole("button", {name: "Closed secret"}).click());
const closedFill = await attempt(() => p.getByLabel("Closed field").fill("x1"));
const after = String(await p.state());
const dom = await p.evaluate(() => ({title: document.title, closedClicked: !!window.closedClicked, closed: window._closed.querySelector("input").value}));
const read = await p.read();
console.log("TARGETS " + JSON.stringify({card, pay, byName, shared, typed, located, paid, miss, closedClick, closedFill, dom,
  cardFilled: after.includes("4242424242424242"), paidShown: /"Paid"/.test(after),
  frameText: read.text.includes("XO_WIDGET_TEXT"), frameLine: /\\[frame: Pay widget\\]/.test(read.text), markdown: read.text.startsWith(read.markdown)}));
`;

test(
  "one target resolver: names, refs, frames and closed shadow roots",
  { skip: missingChrome() },
  async () => {
    let widgetUrl = "";
    const widget = await serve(() => WIDGET);
    const main = await serve(() => page(widgetUrl));
    widgetUrl = `http://localhost:${widget.address().port}/widget`;
    const chrome = await startBridgeChrome("target-resolver");
    try {
      const out = await chrome.repl(CELL(`http://127.0.0.1:${main.address().port}/`), 180000);
      const result = readLine(out.stdout, "TARGETS");
      assert.ok(result, out.stdout + out.stderr);
      const show = JSON.stringify(result);
      assert.ok(
        result.card && result.pay,
        "bu.state lists the cross-origin frame's controls: " + show,
      );
      assert.equal(result.byName.ok, true, show);
      assert.equal(result.dom.title, "loaded", "an exact unique name clicks: " + show);
      assert.equal(result.shared.ok, false);
      assert.match(result.shared.error, /TARGET_AMBIGUOUS/);
      assert.match(result.shared.error, /\[\d+\] button "Save".*\[\d+\] button "Save"/);
      assert.equal(result.typed.ok, true, "page.type takes a frame ref: " + show);
      assert.equal(result.located.ok, true, "page.locator takes a frame ref: " + show);
      assert.ok(result.cardFilled, show);
      assert.ok(result.paidShown, show);
      assert.equal(result.miss.ok, false);
      assert.match(
        result.miss.error,
        /closest: .*"Card number"/,
        "a miss names the closest control",
      );
      assert.doesNotMatch(result.miss.error, /not a valid selector/);
      assert.equal(result.closedClick.ok, true, show);
      assert.equal(result.closedFill.ok, true, show);
      assert.equal(result.dom.closedClicked, true, show);
      assert.equal(result.dom.closed, "x1", show);
      assert.ok(result.frameText && result.frameLine && result.markdown, show);
    } finally {
      await chrome.stop();
      main.close();
      widget.close();
    }
  },
);
