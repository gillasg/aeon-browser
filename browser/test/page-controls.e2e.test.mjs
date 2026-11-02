// Real-Chrome checks for page controls: clearing pop-ups and emulating a phone.
// Run alone: node --test test/page-controls.e2e.test.mjs
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

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "overlays.dismiss rejects a cookie notice and closes a promotion; emulate serves the phone page",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-controls-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/form") {
        response.end(`<title>Apply</title><form onsubmit="event.preventDefault();document.body.innerHTML='Thanks, '+this.email.value+' from '+this.country.value+(this.agree.checked?' (agreed)':'')">
          <label>Email <input name="email"></label>
          <label>Country <select name="country"><option>Canada</option><option>India</option></select></label>
          <label><input type="checkbox" name="agree"> I agree</label>
          <button>Continue</button></form>`);
        return;
      }
      const mobile = /iPhone|Mobile/.test(request.headers["user-agent"] ?? "");
      response.end(
        `<meta name="viewport" content="width=device-width"><title>Shop</title><p id="served">${mobile ? "phone page" : "desktop page"}</p>
         <div id="cookies" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">
           We use cookies to improve your experience.
           <button onclick="window.choice='accept';this.parentNode.remove()">Accept all</button>
           <button onclick="window.choice='reject';this.parentNode.remove()">Reject all</button>
         </div>
         <div id="promo" role="dialog" style="position:fixed;top:20%;left:20%;width:400px;height:200px;background:#fff">
           Get 10% off! Subscribe to our newsletter.
           <button aria-label="Close" onclick="this.parentNode.remove()">×</button>
         </div>`,
      );
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-controls-chrome-"));
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
      const cell = (code) =>
        run(process.execPath, [cli, "repl", "--session", "controls", code], { env });
      const cleared = await cell(`page = await browser.openTab(${JSON.stringify(siteUrl)});
        const result = await page.overlays.dismiss();
        console.log("CLEARED " + JSON.stringify({result, choice: await page.evaluate(() => window.choice ?? null), left: await page.evaluate(() => document.querySelectorAll('#cookies,#promo').length)}));`);
      const out = JSON.parse(/CLEARED (.*)/.exec(cleared.stdout)?.[1] ?? "null");
      assert.ok(out, cleared.stdout + cleared.stderr);
      assert.equal(out.choice, "reject", cleared.stdout);
      assert.equal(out.left, 0, cleared.stdout);
      const form = await cell(`await page.goto(${JSON.stringify(siteUrl + "form")});
        const filled = await page.fillForm({Email: 'a@b.c', Country: 'India', 'I agree': true}, {submit: 'Continue', expect: 'Thanks'});
        console.log("FORM " + JSON.stringify({ok: filled.ok, text: await page.evaluate(() => document.body.innerText)}));`);
      const sent = JSON.parse(/FORM (.*)/.exec(form.stdout)?.[1] ?? "null");
      assert.ok(sent?.ok, form.stdout + form.stderr);
      assert.match(sent.text, /Thanks, a@b\.c from India \(agreed\)/, form.stdout);
      // A watcher's keyed diff: the first call is the baseline, later calls name what moved.
      const diff = await cell(`browser.changes('rows', [{id: 1, p: 5}, {id: 2}]);
        console.log("DIFF " + JSON.stringify(browser.changes('rows', [{id: 1, p: 4}, {id: 3}])));`);
      const moved = JSON.parse(/DIFF (.*)/.exec(diff.stdout)?.[1] ?? "null");
      assert.deepEqual(moved?.new, [{ id: 3 }], diff.stdout + diff.stderr);
      assert.deepEqual(moved.gone, [{ id: 2 }], diff.stdout);
      assert.equal(moved.changed[0].after.p, 4, diff.stdout);
      await cell(`await page.goto(${JSON.stringify(siteUrl)})`);
      const phone = await cell(`await page.emulate({device: 'iPhone', colorScheme: 'dark'});
        console.log("PHONE " + JSON.stringify(await page.evaluate(() => ({served: document.getElementById('served').textContent, width: innerWidth, dark: matchMedia('(prefers-color-scheme: dark)').matches, touch: navigator.maxTouchPoints}))));`);
      const shown = JSON.parse(/PHONE (.*)/.exec(phone.stdout)?.[1] ?? "null");
      assert.ok(shown, phone.stdout + phone.stderr);
      assert.equal(shown.served, "phone page", phone.stdout);
      assert.ok(shown.width < 500, phone.stdout);
      assert.equal(shown.dark, true, phone.stdout);
      assert.ok(shown.touch > 0, phone.stdout);
      const reset = await cell(`await page.emulate({reset: true}); await page.reload();
        console.log("RESET " + JSON.stringify(await page.evaluate(() => ({width: innerWidth, dark: matchMedia('(prefers-color-scheme: dark)').matches}))));`);
      const back = JSON.parse(/RESET (.*)/.exec(reset.stdout)?.[1] ?? "null");
      assert.ok(back && back.width > 500, reset.stdout + reset.stderr);
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
);

async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
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
  return cdp;
}

function nativeBootstrap(env, message) {
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
      JSON.stringify(
        message ?? {
          kind: "native.bootstrap",
          protocolVersion: { major: 1, minor: 6 },
          clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
          browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
        },
      ),
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
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}
