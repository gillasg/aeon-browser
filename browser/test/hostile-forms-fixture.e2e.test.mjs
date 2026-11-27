// Real Chrome against local fixtures: hostile form widgets (controlled inputs, portal comboboxes,
// date/range/slider, pointer sortables, contenteditable, open and closed shadow roots, same- and
// cross-origin iframes, file upload and download) driven through the engine, so each stays guarded.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { chromePort } from "./helpers/chrome-port.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

const PAGE = (other) => `<!doctype html><title>hostile</title>
<style>body{font:14px sans-serif;margin:8px} .card{width:160px;height:40px;margin:6px 0;background:#ddd;touch-action:none} [role=slider]{display:inline-block;width:120px;height:16px;background:#ccc}</style>
<section><input id="react" aria-label="React name"> <span id="react-state"></span>
<input id="lazy" aria-label="Lazy"> <span id="lazy-model"></span>
<input id="search" type="search" aria-label="Query"> <span id="search-query"></span></section>
<section><button id="fruit" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="fruit-list">Pick a fruit</button> <span id="fruit-value"></span></section>
<section><input id="date" type="date" aria-label="Day"> <input id="range" type="range" min="0" max="100" value="10" aria-label="Volume">
<div id="slider" role="slider" tabindex="0" aria-label="Level" aria-valuemin="0" aria-valuemax="10" aria-valuenow="3"></div></section>
<section id="sortable"><div class="card" data-id="a">Alpha</div><div class="card" data-id="b">Bravo</div><div class="card" data-id="c">Charlie</div></section>
<section><div id="editor" contenteditable="true" role="textbox" aria-label="Notes"><p><br></p></div> <span id="editor-model"></span></section>
<section><x-form></x-form> <x-secret></x-secret></section>
<section><input id="file" type="file" aria-label="Attachment"> <span id="file-read"></span>
<a id="dl" href="/report.csv">Download report</a></section>
<iframe id="same" src="/inner" width="300" height="80"></iframe>
<iframe id="cross" src="${other}/outer" width="300" height="80"></iframe>
<script>
window.log = {change: [], react: 0};
// React-style: state follows trusted input events only; every render writes state back.
var react = document.getElementById('react'), state = '';
react.addEventListener('input', (e) => { if (e.isTrusted || e.inputType) state = react.value; react.value = state; window.log.react++; document.getElementById('react-state').textContent = state; });
// v-model.lazy commits on change; a search box commits its query on Enter.
var lazy = document.getElementById('lazy');
lazy.addEventListener('change', () => { document.getElementById('lazy-model').textContent = lazy.value; });
var search = document.getElementById('search');
search.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('search-query').textContent = search.value; });
// Portal listbox appended to body, far from its trigger, with a filter input.
var fruit = document.getElementById('fruit');
fruit.addEventListener('click', () => {
  if (document.getElementById('fruit-list')) return;
  var pop = document.createElement('div'); pop.id = 'fruit-pop';
  pop.innerHTML = '<input id="fruit-filter" aria-label="Filter fruit"><div id="fruit-list" role="listbox"></div>';
  document.body.appendChild(pop); fruit.setAttribute('aria-expanded', 'true');
  var list = pop.querySelector('#fruit-list'), filter = pop.querySelector('#fruit-filter');
  var draw = () => { list.innerHTML = ''; for (var name of ['Apple', 'Banana', 'Cherry'].filter((n) => n.toLowerCase().includes(filter.value.toLowerCase()))) { var o = document.createElement('div'); o.setAttribute('role', 'option'); o.textContent = name; list.appendChild(o); } };
  filter.addEventListener('input', draw); draw(); filter.focus();
  list.addEventListener('click', (e) => { var o = e.target.closest('[role=option]'); if (!o) return; document.getElementById('fruit-value').textContent = o.textContent; fruit.textContent = o.textContent; fruit.setAttribute('aria-expanded', 'false'); pop.remove(); });
});
for (var id of ['date', 'range']) document.getElementById(id).addEventListener('change', (e) => window.log.change.push(e.target.id + '=' + e.target.value));
var slider = document.getElementById('slider');
slider.addEventListener('keydown', (e) => { var v = +slider.getAttribute('aria-valuenow'); if (e.key === 'ArrowRight') v = Math.min(10, v + 1); if (e.key === 'ArrowLeft') v = Math.max(0, v - 1); slider.setAttribute('aria-valuenow', v); });
// Pointer sortable: the card under the release point takes the dragged card before it.
var dragged = null, box = document.getElementById('sortable');
box.addEventListener('pointerdown', (e) => { dragged = e.target.closest('.card'); if (dragged) dragged.setPointerCapture?.(e.pointerId); });
box.addEventListener('pointermove', (e) => { if (dragged) dragged.dataset.moved = '1'; });
document.addEventListener('pointerup', (e) => { if (!dragged) return; var under = [...box.children].find((c) => { var r = c.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; }); if (under && under !== dragged && dragged.dataset.moved) { var r = under.getBoundingClientRect(); box.insertBefore(dragged, e.clientY > r.top + r.height / 2 ? under.nextSibling : under); } dragged = null; });
// Rich-text editor: the model is rebuilt from the paragraphs on every input.
var editor = document.getElementById('editor'); window.editorModel = {inputs: 0, text: ''};
editor.addEventListener('beforeinput', () => window.editorModel.inputs++);
editor.addEventListener('input', () => { window.editorModel.text = [...editor.querySelectorAll('p')].map((p) => p.textContent).join('\\n') || editor.textContent; document.getElementById('editor-model').textContent = window.editorModel.text; });
function shadowForm(mode, label) {
  return class extends HTMLElement { connectedCallback() {
    var root = this.attachShadow({mode});
    root.innerHTML = '<input aria-label="' + label + '" class="v"> <button>' + label + ' submit</button> <output></output>';
    root.querySelector('button').addEventListener('click', () => { root.querySelector('output').textContent = 'sent:' + root.querySelector('input').value; this.dataset.sent = root.querySelector('input').value; });
  } };
}
customElements.define('x-form', shadowForm('open', 'Shadow name'));
customElements.define('x-secret', shadowForm('closed', 'Secret code'));
document.getElementById('file').addEventListener('change', (e) => { var f = e.target.files[0], r = new FileReader(); r.onload = () => { document.getElementById('file-read').textContent = f.name + ':' + r.result; }; r.readAsText(f); });
</script>`;
const FRAME = (
  label,
) => `<!doctype html><title>${label}</title><input id="fi" aria-label="${label} field"> <button id="fb">${label} go</button> <span id="fo"></span>
<script>document.getElementById('fb').addEventListener('click', () => { document.getElementById('fo').textContent = 'got:' + document.getElementById('fi').value; });</script>`;
const SCRIPT = `page = await browser.openTab(URL);
var t = async (tag, fn) => { try { console.log(tag + ' ' + JSON.stringify(await fn())); } catch (e) { console.log(tag + ' ' + JSON.stringify({error: String(e.message || e).slice(0, 240)})); } };
var text = (sel) => page.locator(sel).innerText();
await t('R1', async () => { var r = await page.locator('#react').fill('frieren'); return {value: r.value, state: await text('#react-state')}; });
await t('R2', async () => { await page.locator('#lazy').fill('lazy-v', {commit: 'blur'}); return await text('#lazy-model'); });
await t('R3', async () => { await page.locator('#search').fill('mimic', {commit: 'enter'}); return await text('#search-query'); });
await t('C', async () => { await page.locator('#fruit').click(); await page.locator('#fruit-filter').fill('ban'); var n = await page.getByRole('option').count(); await page.getByRole('option', {name: 'Banana'}).click(); return {n, value: await text('#fruit-value'), expanded: await page.evaluate(() => document.getElementById('fruit').getAttribute('aria-expanded'))}; });
await t('D', async () => { await page.locator('#date').fill('2026-11-26'); await page.locator('#range').fill('70'); await page.locator('#slider').press('ArrowRight'); return await page.evaluate(() => ({date: document.getElementById('date').value, range: document.getElementById('range').value, slider: document.getElementById('slider').getAttribute('aria-valuenow'), change: window.log.change})); });
await t('S', async () => { var r = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => { var b = c.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })); await page.drag(r[0][0], r[0][1], r[2][0], r[2][1] + 15); return await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id).join('')); });
await t('E', async () => { var r = await page.locator('#editor').fill('Hello rich text'); return {via: r && r.via, dom: await page.evaluate(() => document.getElementById('editor').textContent), model: await page.evaluate(() => window.editorModel)}; });
await t('O', async () => { await page.getByLabel('Shadow name').fill('open-v'); await page.getByRole('button', {name: 'Shadow name submit'}).click(); return await page.evaluate(() => document.querySelector('x-form').dataset.sent ?? null); });
await t('X1', async () => { await page.getByLabel('Secret code').fill('closed-v'); return 'filled'; });
await t('X2', async () => { await page.getByRole('button', {name: 'Secret code submit'}).click(); return 'clicked'; });
await t('X5', async () => { await page.getByRole('textbox', {name: 'Secret code'}).fill('closed-v'); await page.getByRole('button', {name: 'Secret code submit'}).click(); return 'filled'; });
await t('X3', async () => { await page.locator('x-secret input').fill('closed-v'); return 'filled'; });
await t('X4', async () => page.evaluate(() => ({sent: document.querySelector('x-secret').dataset.sent ?? null, root: document.querySelector('x-secret').shadowRoot})));
await t('F', async () => { var frames = await page.frames(); var out = {}; for (var [k, part] of [['same', '/inner'], ['cross', '/outer']]) { var f = frames.find((x) => String(x.url).includes(part)); if (!f) { out[k] = 'missing'; continue; } await f.fill('#fi', k + '-v'); await f.click('#fb'); out[k] = await f.evaluate(() => document.getElementById('fo').textContent); } return out; });
await t('U', async () => { await artifact('graft-upload.txt', 'hello from graft'); await page.upload('#file', ['graft-upload.txt']); for (var i = 0; i < 25 && !(await text('#file-read')); i++) await new Promise((r) => setTimeout(r, 200)); return await page.evaluate(() => ({read: document.getElementById('file-read').textContent, name: document.getElementById('file').files[0]?.name ?? null})); });
await t('W', async () => { await page.downloads.start(); await page.locator('#dl').click(); var d = await page.downloads.waitFor('graft-report.csv', 15000); await page.downloads.stop(); return {name: d.suggestedFilename, state: d.state, bytes: d.totalBytes, url: d.url.split('/').pop()}; });`;

test(
  "hostile form widgets work in real Chrome against local fixtures",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-hostile-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const cross = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(FRAME("Cross"));
    });
    await new Promise((done) => cross.listen(0, "127.0.0.1", done));
    const other = `http://127.0.0.1:${cross.address().port}`;
    const site = createServer((request, response) => {
      if (request.url === "/report.csv") {
        response.setHeader("content-type", "text/csv");
        response.setHeader("content-disposition", 'attachment; filename="graft-report.csv"');
        return response.end("name,score\ngraft,10\n");
      }
      response.setHeader("content-type", "text/html");
      response.end(request.url === "/inner" ? FRAME("Same") : PAGE(other));
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-hostile-chrome-"));
    // Downloads land in the profile, not the runner's own Downloads folder.
    const saved = join(profile, "saved");
    await mkdir(join(profile, "Default"), { recursive: true });
    await writeFile(
      join(profile, "Default", "Preferences"),
      JSON.stringify({ download: { default_directory: saved, prompt_for_download: false } }),
    );
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(
        chromePath,
        [
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          `--load-extension=${extension}`,
          `--disable-extensions-except=${extension}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--headless=new",
          ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      await connectExtension(profile, env);
      const script = SCRIPT.replace("URL", JSON.stringify(url));
      const result = await run(process.execPath, [cli, "repl", "--session", "hostile", script], {
        env,
      });
      const out = result.stdout + result.stderr;
      const line = (tag) =>
        JSON.parse(
          out
            .split("\n")
            .find((text) => text.startsWith(tag + " "))
            ?.slice(tag.length + 1) ?? "null",
        );
      // 1. Controlled inputs: React-style state, v-model.lazy on blur, search on Enter.
      assert.deepEqual(line("R1"), { value: "frieren", state: "frieren" }, out);
      assert.equal(line("R2"), "lazy-v", out);
      assert.equal(line("R3"), "mimic", out);
      // 2. Portal listbox: opened, filtered to one option, picked, closed.
      assert.deepEqual(line("C"), { n: 1, value: "Banana", expanded: "false" }, out);
      // 3. Date, range (both fire change) and an ARIA slider stepped by ArrowRight.
      assert.deepEqual(
        line("D"),
        {
          change: ["date=2026-11-26", "range=70"],
          date: "2026-11-26",
          range: "70",
          slider: "4",
        },
        out,
      );
      // 4. Pointer sortable: Alpha dragged below Charlie.
      assert.equal(line("S"), "bca", out);
      // 5. contenteditable: DOM and the editor model both hold the text.
      const editor = line("E");
      assert.equal(editor?.dom, "Hello rich text", out);
      assert.equal(editor.model.text, "Hello rich text", out);
      assert.ok(editor.model.inputs > 0, out);
      // 6. Open shadow root: label fill and role click reach inside.
      assert.equal(line("O"), "open-v", out);
      // 7. Closed shadow root: the accessibility tree reaches it (label fill, role fill and
      // click work); CSS lookups cannot see into it and say so.
      assert.equal(line("X1"), "filled", out);
      assert.equal(line("X2"), "clicked", out);
      assert.equal(line("X5"), "filled", out);
      assert.match(line("X3")?.error ?? "", /TARGET_NOT_FOUND/, out);
      assert.deepEqual(line("X4"), { root: null, sent: "closed-v" }, out);
      // 8. Same-origin and cross-origin (other port) iframes: fill and click in each.
      assert.deepEqual(line("F"), { same: "got:same-v", cross: "got:cross-v" }, out);
      // 9. Upload: the page sees the file name and reads its contents.
      assert.deepEqual(
        line("U"),
        { name: "graft-upload.txt", read: "graft-upload.txt:hello from graft" },
        out,
      );
      // 10. Download: tracked to completion and saved with its attachment name.
      assert.deepEqual(
        line("W"),
        { name: "graft-report.csv", state: "completed", bytes: 19, url: "report.csv" },
        out,
      );
      const files = await waitFor(async () => {
        const names = await readdir(saved);
        if (!names.includes("graft-report.csv")) throw new Error(names.join());
        return names;
      }, 5000);
      assert.ok(files.includes("graft-report.csv"), out);
      assert.equal(
        await readFile(join(saved, "graft-report.csv"), "utf8"),
        "name,score\ngraft,10\n",
      );
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      cross.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
  120000,
);

async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  }, 60000);
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(
      process.execPath,
      [cli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      {
        env,
      },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: { major: 1, minor: 6 },
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
      }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(150);
    }
  }
  throw last ?? new Error("timed out");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return async (method, params = {}) => {
    await opened;
    const callId = ++id;
    socket.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((done) => waiting.set(callId, done));
  };
}
