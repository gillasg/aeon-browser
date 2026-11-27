// Real Chrome, a local ARIA combobox whose options arrive 250 ms after each keystroke (the
// airport / city / address pattern). page.fillForm types the value, waits for a matching option,
// clicks it and reads the field back; a value no option matches fails NO_OPTION naming the
// options that did appear.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { missingChrome, readLine, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const COMBO = `<!doctype html><meta charset="utf-8"><title>Combobox</title>
<label for="cb">Country</label>
<input id="cb" role="combobox" aria-expanded="false" aria-controls="lb" aria-autocomplete="list">
<ul id="lb" role="listbox" hidden></ul>
<script>
const all = ["India", "Indonesia", "Iceland", "Ireland", "Italy"];
cb.oninput = () => {
  lb.innerHTML = "";
  setTimeout(() => {
    all.filter((c) => c.toLowerCase().startsWith(cb.value.slice(0, 1).toLowerCase())).forEach((c) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = c;
      li.onmousedown = (e) => { e.preventDefault(); cb.value = c; cb.dataset.picked = c; lb.hidden = true; };
      lb.appendChild(li);
    });
    lb.hidden = false;
    cb.setAttribute("aria-expanded", "true");
  }, 250);
};
</script>`;

test(
  "fillForm picks an option from an async ARIA combobox",
  { skip: missingChrome() },
  async () => {
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(COMBO);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const chrome = await startBridgeChrome("combobox-fill");
    try {
      const out = await chrome.repl(
        `const p = await browser.openTab(${JSON.stringify(url)}, {newTab: true});
const attempt = async (run) => { try { return {ok: true, value: await run()}; } catch (e) { return {ok: false, error: String(e && e.message || e).slice(0, 400)}; } };
const filled = await attempt(() => p.fillForm({Country: "italy"}));
const picked = await p.evaluate(() => ({value: cb.value, picked: cb.dataset.picked || null}));
const missing = await attempt(() => p.fillForm({Country: "Iberia"}));
console.log("COMBO " + JSON.stringify({filled, picked, missing}));`,
        120000,
      );
      const result = readLine(out.stdout, "COMBO");
      assert.ok(result, out.stdout + out.stderr);
      const show = JSON.stringify(result);
      assert.equal(result.filled.ok, true, show);
      assert.deepEqual(result.picked, { value: "Italy", picked: "Italy" }, show);
      assert.equal(result.missing.ok, false, show);
      assert.match(result.missing.error, /NO_OPTION/);
      assert.match(result.missing.error, /India \| Indonesia \| Iceland \| Ireland \| Italy/, show);
    } finally {
      await chrome.stop();
      site.close();
    }
  },
);
