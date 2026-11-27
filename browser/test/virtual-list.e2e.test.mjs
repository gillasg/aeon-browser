// Real Chrome, a local page with a 1000-row virtual list (twelve rows drawn at a time, recycled on
// scroll) and a feed that loads 20 more items each time the window nears its end. page.list must
// collect every row inside its time budget; one that runs out returns {partial: true, items}
// instead of throwing them away; page.read reaches the end of both the list and the feed.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { missingChrome, readLine, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const VIRTUAL = `<!doctype html><meta charset="utf-8"><title>Virtual</title>
<div id="vp" style="height:300px;overflow:auto;position:relative"><div id="sp" style="height:30000px"></div></div>
<div id="feed"></div>
<script>
const vp = document.getElementById("vp"), sp = document.getElementById("sp");
function draw() {
  const s = Math.floor(vp.scrollTop / 30);
  sp.innerHTML = "";
  for (let i = s; i < Math.min(1000, s + 12); i++) {
    const d = document.createElement("div");
    d.setAttribute("role", "row");
    d.style.cssText = "position:absolute;top:" + i * 30 + "px;height:30px";
    d.textContent = "Row " + i;
    sp.appendChild(d);
  }
}
vp.onscroll = draw;
draw();
let n = 0, loading = false;
function more() {
  loading = false;
  for (let k = 0; k < 20; k++) {
    const a = document.createElement("article");
    a.textContent = "Feed item " + n++;
    feed.appendChild(a);
  }
}
more();
addEventListener("scroll", () => {
  if (n >= 100 || loading || innerHeight + scrollY <= document.body.scrollHeight - 200) return;
  loading = true;
  setTimeout(more, 200);
});
</script>`;

test(
  "page.list and page.read collect a virtual list and an infinite feed",
  { skip: missingChrome() },
  async () => {
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(VIRTUAL);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/virtual`;
    const chrome = await startBridgeChrome("virtual-list");
    try {
      const out = await chrome.repl(
        `const p = await browser.openTab(${JSON.stringify(url)}, {newTab: true});
const t0 = Date.now();
const all = await p.list("#vp [role=row]");
const listMs = Date.now() - t0;
const cut = await p.list("#vp [role=row]", {timeMs: 1200});
const t1 = Date.now();
const read = await p.read({max: 200000});
const readMs = Date.now() - t1;
const rows = new Set(all.items.map((item) => item.text));
const json = JSON.stringify(read);
const feed = Math.max(...[...read.text.matchAll(/Feed item (\\d+)/g)].map((m) => Number(m[1])));
console.log("LIST " + JSON.stringify({count: all.count, unique: rows.size, has0: rows.has("Row 0"), has999: rows.has("Row 999"), complete: all.complete, listMs,
  cutPartial: cut.partial, cutCount: cut.items.length, readRow999: json.includes("Row 999"), feed, readMs, notes: read.notes}));`,
        180000,
      );
      const result = readLine(out.stdout, "LIST");
      assert.ok(result, out.stdout + out.stderr);
      assert.equal(result.unique, 1000, JSON.stringify(result));
      assert.ok(result.has0 && result.has999, JSON.stringify(result));
      assert.equal(result.complete, true);
      // The guide's budget is 20 s for a list like this; a CI runner gets the same 2x margin as
      // read-speed.e2e.test.mjs.
      assert.ok(result.listMs <= 40000, `page.list took ${result.listMs} ms`);
      assert.equal(result.cutPartial, true, "a list cut by its budget says partial");
      assert.ok(result.cutCount > 12, "a partial list keeps the rows it saw");
      assert.ok(result.readRow999, "page.read reached the end of the virtual list");
      assert.equal(result.feed, 99, "page.read scrolled the window until the feed ended");
      assert.ok(
        !result.notes.some((note) => / at \S+ \(/.test(note)),
        "notes carry no stack traces",
      );
    } finally {
      await chrome.stop();
      site.close();
    }
  },
);
