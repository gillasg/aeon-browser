// Real Chrome: selectOption on an ARIA combobox or listbox chooses a visible option
// inside aria-controls. A native <select> still sets its value. Run alone, from browser/:
// node --test test/combobox-select.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

// The stray Paris sits before the real list, so an unscoped option search clicks it first.
const pageHtml = `<!doctype html><title>Cities</title>
<div id="stray" role="option" data-value="stray" style="width:120px;height:28px" onclick="strayClicks++">Paris</div>
<div id="city" role="combobox" aria-label="City" aria-controls="city-list" aria-expanded="false" tabindex="0" style="width:200px;height:32px;border:1px solid #000" onclick="cityOpen()">Choose</div>
<ul id="city-list" role="listbox" hidden>
  <li role="option" data-value="lon" style="display:block;height:28px" onclick="pickCity(this)">London</li>
  <li role="option" data-value="par" style="display:block;height:28px" onclick="pickCity(this)">Paris</li>
</ul>
<div id="town" role="combobox" aria-label="Town" aria-controls="town-list" tabindex="0" style="width:200px;height:32px" onclick="townOpen()">Choose</div>
<ul id="town-list" role="listbox" hidden>
  <li role="option" data-value="ber" style="display:block;height:28px" onclick="pickTown(this)">Berlin</li>
  <li role="option" data-value="rom" style="display:block;height:28px" onclick="pickTown(this)">Rome</li>
</ul>
<div id="locked" role="combobox" aria-label="Locked" aria-disabled="true" aria-controls="lock-list" tabindex="0" style="width:200px;height:32px" onclick="lockOpens++">Nope</div>
<ul id="lock-list" role="listbox" hidden>
  <li role="option" style="display:block;height:28px">Nope</li>
</ul>
<div id="colors" role="listbox" aria-label="Colors" aria-multiselectable="true" style="width:200px">
  <div role="option" data-value="red" aria-selected="true" style="height:28px" onclick="redClicks++;this.setAttribute('aria-selected','false')">Red</div>
  <div role="option" data-value="green" aria-selected="false" style="height:28px" onclick="greenClicks++;this.setAttribute('aria-selected','true')">Green</div>
</div>
<label>Country <select id="country"><option value="ca">Canada</option><option value="in">India</option></select></label>
<div id="region" role="combobox" aria-label="Region" aria-controls="region-list" tabindex="0" style="width:200px;height:32px" onclick="openRegion()">Pick</div>
<ul id="region-list" role="listbox" hidden></ul>
<script>
var cityValue = '', townValue = '', regionValue = '', strayClicks = 0, lockOpens = 0, redClicks = 0, greenClicks = 0;
function cityOpen() { var list = document.getElementById('city-list'); list.hidden = false; document.getElementById('city').setAttribute('aria-expanded', 'true'); }
function pickCity(el) { cityValue = el.getAttribute('data-value'); document.getElementById('city').textContent = el.textContent; document.getElementById('city-list').hidden = true; }
function townOpen() { document.getElementById('town-list').hidden = false; }
function pickTown(el) { townValue = el.getAttribute('data-value'); document.getElementById('town').textContent = el.textContent; document.getElementById('town-list').hidden = true; }
function openRegion() {
  var list = document.getElementById('region-list');
  if (list.childElementCount) { list.hidden = false; return; }
  list.hidden = false;
  for (var name of ['North', 'West']) {
    var li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('data-value', name.toLowerCase());
    li.style.cssText = 'display:block;height:28px';
    li.textContent = name;
    li.onclick = function () { regionValue = this.getAttribute('data-value'); document.getElementById('region').textContent = this.textContent; list.hidden = true; };
    list.appendChild(li);
  }
}
</script>`;

test(
  "selectOption chooses an ARIA option inside aria-controls and keeps a native select",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-combobox-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-combobox-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      await connectExtension(profile, env);
      const result = await repl(env, cell(url));
      const out = `${result.stdout}\n${result.stderr}`;
      const city = readHit(out, "CITY");
      assert.equal(city.status, "ok", out);
      assert.equal(city.hits.city, "par", out);
      assert.equal(city.hits.stray, 0, out);
      const town = readHit(out, "VALUE");
      assert.equal(town.status, "ok", out);
      assert.equal(town.hits.town, "ber", out);
      const miss = readHit(out, "MISS");
      assert.match(miss.status, /NO_OPTION/, out);
      assert.match(miss.status, /London/, out);
      assert.match(miss.status, /Paris/, out);
      assert.equal(miss.hits.stray, 0, out);
      const lock = readHit(out, "LOCK");
      assert.match(lock.status, /TARGET_DISABLED/, out);
      assert.equal(lock.hits.lock, 0, out);
      const multi = readHit(out, "MULTI");
      assert.equal(multi.status, "ok", out);
      assert.equal(multi.hits.red, 0, out);
      assert.equal(multi.hits.redOn, "true", out);
      assert.equal(multi.hits.green, 1, out);
      assert.equal(multi.hits.greenOn, "true", out);
      const native = readHit(out, "NATIVE");
      assert.equal(native.status, "ok", out);
      assert.equal(native.hits.country, "in", out);
      const form = readHit(out, "FORM");
      assert.equal(form.status, "ok", out);
      assert.equal(form.hits.region, "west", out);
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
  180000,
);

function readHit(out, label) {
  const text = new RegExp(`${label} (ok|ERR .*) (\\{.*\\})`).exec(out);
  if (!text) return { status: "", hits: {} };
  return { status: text[1], hits: JSON.parse(text[2]) };
}

function cell(url) {
  return `const page = await browser.openTab(${JSON.stringify(url)});
async function hit(label, run) {
  let status = "ok";
  try { await run(); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  const hits = await page.evaluate(() => ({
    city: cityValue, town: townValue, region: regionValue, stray: strayClicks, lock: lockOpens,
    red: redClicks, green: greenClicks,
    redOn: document.querySelector('[data-value=red]').getAttribute('aria-selected'),
    greenOn: document.querySelector('[data-value=green]').getAttribute('aria-selected'),
    country: document.querySelector('#country').value,
  }));
  console.log(label + " " + status + " " + JSON.stringify(hits));
}
await hit("CITY", () => page.getByRole("combobox", {name: "City"}).selectOption("Paris"));
await hit("VALUE", () => page.getByRole("combobox", {name: "Town"}).selectOption({value: "ber"}));
await hit("MISS", () => page.getByRole("combobox", {name: "City"}).selectOption("Madrid"));
await hit("LOCK", () => page.getByRole("combobox", {name: "Locked"}).selectOption("Nope"));
await hit("MULTI", () => page.getByRole("listbox", {name: "Colors"}).selectOption(["Red", "Green"]));
await hit("NATIVE", () => page.locator("#country").selectOption("India"));
await hit("FORM", () => page.fillForm({Region: "West"}));`;
}

function chromeArgs(profile) {
  return [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

async function repl(env, code) {
  try {
    return await run(
      process.execPath,
      [cli, "repl", "--session", "combobox", "--timeout", "120000", code],
      { env, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}\n${error.message ?? ""}`,
    };
  }
}

async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    );
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
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
    response.json(),
  );
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
      { env },
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
      await sleep(100);
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
