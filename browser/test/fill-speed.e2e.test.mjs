// Real-Chrome timings for form fills: every field goes through the engine (bu.type, page.act and
// page.fillForm), and a password still reaches the user's password manager. A local form with the
// shape of a sign-up page: text, email, tel, selects, two password fields and a submit. The
// timings are printed, not asserted: a shared machine makes wall-clock budgets flaky, so the test
// asserts what the fill did (every field read back, real key events, the save) and leaves speed
// visible in the output for a human or a benchmark to judge.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { fakeVault, NEW } from "./vault-site.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const execRun = promisify(execFile);
const run = async (...args) => {
  try {
    return await execRun(...args);
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n");
    if (detail) error.message = `${error.message}\n${detail}`;
    throw error;
  }
};

// Eight fillable controls, labels tied to their inputs (what page.controls and fillForm read).
const FORM = `<!doctype html><meta charset="utf-8"><title>Create account</title>
<main><h1>Create account</h1>
<form id="form" onsubmit="event.preventDefault(); this.remove(); document.getElementById('out').textContent = 'Account created'">
  <label>Full name <input name="name" autocomplete="name"></label>
  <label>Email <input name="email" type="email" autocomplete="username"></label>
  <label>Phone <input name="phone" type="tel" autocomplete="tel"></label>
  <label>Company <input name="company" autocomplete="organization"></label>
  <label>Address <input name="address" autocomplete="street-address"></label>
  <label>Country <select name="country"><option>Canada</option><option>India</option><option>United Kingdom</option></select></label>
  <label>Password <input name="password" type="password" autocomplete="new-password" onkeydown="this.dataset.keys = '1'"></label>
  <label>Confirm password <input name="confirm" type="password" autocomplete="new-password" onkeydown="this.dataset.keys = '1'"></label>
  <label><input name="news" type="checkbox"> Send me updates</label>
  <button type="submit">Create account</button>
</form>
<p id="out"></p></main>
<script>
  // Real sign-up pages listen for keys at the document level; typing must stay real key events.
  document.addEventListener("keydown", () => { document.body.dataset.typed = "1" });
</script>`;

// The engine path under test: an id from bu.state(), a plain page.act action, and fillForm's
// per-step timings. Returns raw numbers; the test decides what they mean.
const TIMING_CELL = (url) => `
page = await browser.openTab(${JSON.stringify(url)});
await page.waitForLoadState('domcontentloaded').catch(() => {});
const state = await bu.state();
const idOf = (label) => {
  const line = state.split(String.fromCharCode(10)).find((text) => /^\\s*\\[\\d+\\] /.test(text) && text.includes('"' + label + '"'));
  if (!line) throw Error('no id for ' + label);
  return Number(/^\\s*\\[(\\d+)\\]/.exec(line)[1]);
};
const label = async (name, value) => {
  const at = Date.now();
  await bu.type(idOf(name), value);
  return Date.now() - at;
};
// Warm the debugger, the quiet world and the cursor once; not counted.
await bu.type(idOf('Full name'), 'Warm up');
const runs = [];
for (const pass of [1, 2, 3, 4, 5]) {
  const typed = {};
  // The first action of a pass can land while the previous pass's last command is still
  // settling; warm it so every measured fill starts from the same idle state.
  await bu.type(idOf('Full name'), 'Warm ' + pass);
  typed['Full name'] = await label('Full name', 'Ada Lovelace ' + pass);
  typed.Email = await label('Email', 'ada' + pass + '@example.com');
  typed.Phone = await label('Phone', '+1415555012' + pass);
  typed.Company = await label('Company', 'Analytical Engines ' + pass);
  typed.Address = await label('Address', pass + ' St James Square');
  const actedAt = Date.now();
  await page.act({role: 'textbox', name: 'Company', method: 'fill', args: ['Difference Engine ' + pass]});
  const acted = Date.now() - actedAt;
  const formAt = Date.now();
  const form = await page.fillForm({
    'Full name': 'Grace Hopper ' + pass, Email: 'grace' + pass + '@example.com', Phone: '+1415555098' + pass,
    Company: 'Navy ' + pass, Address: pass + ' Compiler Way', Country: 'India',
    Password: 'fake-new-Passw0rd!', 'Confirm password': 'fake-new-Passw0rd!'
  });
  const formMs = Date.now() - formAt;
  const perField = Object.fromEntries((form.steps || []).map((step) => [step.id, step.ms]));
  runs.push({typed, acted, formMs, perField, ok: form.ok});
}
// What a cell pays after its last action: the same final observation __finishCell makes.
const finalAt = Date.now();
await bu.state({final: true});
const finalMs = Date.now() - finalAt;
// Read every field back after the last pass, so the timings come with proof the fill landed.
const filled = await page.evaluate(() => {
  const form = document.querySelector('form');
  const fields = form
    ? Object.fromEntries([...form.elements].filter((element) => element.name).map((element) => [
        element.name,
        /password|confirm/i.test(element.name)
          ? (element.value ? '[set]' : '')
          : element.type === 'checkbox' ? element.checked : element.value,
      ]))
    : null;
  return { fields, typed: document.body.dataset.typed === '1' };
});
console.log('FILLVALUES ' + JSON.stringify(filled));
console.log('FILLTIMES ' + JSON.stringify({runs, finalMs}));
`;

test(
  "a form fill reaches every field and keeps the password-manager save",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const vault = await fakeVault();
    const home = await mkdtemp(join(tmpdir(), "fill-speed-home-"));
    await writeFile(
      join(home, "password-manager.json"),
      JSON.stringify({ provider: "bitwarden", bitwardenSession: "test" }),
    );
    const env = {
      ...process.env,
      PATH: vault.dir + delimiter + process.env.PATH,
      BROWSER_USE_EXTENSION_HOME: home,
      SITE_TO_API_HOME: join(home, "site-to-api"),
    };
    const site = createServer((request, response) => {
      if (request.url?.startsWith("/ping")) {
        response.setHeader("content-type", "text/plain");
        response.end("ok");
        return;
      }
      response.setHeader("content-type", "text/html");
      // A page with background requests never goes quiet; a cell that observed it would wait
      // out the settle cap, which is exactly the per-fill wait this test guards.
      response.end(
        request.url?.startsWith("/busy")
          ? FORM.replace(
              "</main>",
              '<script>setInterval(() => fetch("/ping?" + Date.now()).catch(() => {}), 200)</script></main>',
            )
          : FORM,
      );
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "fill-speed-chrome-"));
    let chrome;
    try {
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
        run(
          process.execPath,
          [cli, "repl", "--session", "fill-speed", "--timeout", "120000", code],
          {
            env,
          },
        );
      const timed = await cell(TIMING_CELL(url));
      assert.ok(!timed.stdout.includes(NEW.password), "a password reached the output");
      // One field in its own cell, minus an empty cell's process and connect time: what a
      // sign-in pays per fill, final observation included.
      const baselineAt = Date.now();
      await cell("1 + 1");
      const baselineMs = Date.now() - baselineAt;
      const oneAt = Date.now();
      await cell(`await bu.type(idOf('Full name'), 'Quick fill');`);
      const oneCost = Math.max(0, Date.now() - oneAt - baselineMs);
      const times = JSON.parse(/FILLTIMES (.*)/.exec(timed.stdout)?.[1] ?? "null");
      assert.ok(times, timed.stdout + timed.stderr);
      console.log("FILLTIMES " + JSON.stringify(times));
      const runs = times.runs ?? [];
      assert.equal(runs.length, 5, timed.stdout);
      runs.forEach((run) => assert.equal(run.ok, true, timed.stdout));
      const median = (values) => {
        const sorted = [...values].sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      };
      const typedMedian = (name) => median(runs.map((run) => run.typed[name]));
      const actMs = median(runs.map((run) => run.acted));
      // fillForm's own per-step timings, in call order: name, email, phone, company, address,
      // country, password, confirm.
      const stepMedian = (id) => median(runs.map((run) => run.perField[id]));
      console.log(
        "FILLMEDIANS " +
          JSON.stringify({
            oneCost,
            baselineMs,
            typed: Object.fromEntries(
              ["Full name", "Email", "Phone", "Company", "Address"].map((name) => [
                name,
                typedMedian(name),
              ]),
            ),
            act: actMs,
            steps: Object.fromEntries(
              ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => [id, stepMedian(id)]),
            ),
            finalMs: times.finalMs,
          }),
      );
      const filled = JSON.parse(/FILLVALUES (.*)/.exec(timed.stdout)?.[1] ?? "null");
      assert.ok(filled, timed.stdout + timed.stderr);
      assert.deepEqual(
        filled.fields,
        {
          name: "Grace Hopper 5",
          email: "grace5@example.com",
          phone: "+14155550985",
          company: "Navy 5",
          address: "5 Compiler Way",
          country: "India",
          password: "[set]",
          confirm: "[set]",
          news: false,
        },
        timed.stdout,
      );
      assert.equal(filled.typed, true, "the fill sent real key events");
      assert.ok(!timed.stdout.includes("fake-new-Passw0rd!"), "a password reached the output");

      const saved = await cell(`
page = await browser.openTab(${JSON.stringify(url)});
await page.waitForLoadState('domcontentloaded').catch(() => {});
await page.fillForm({Email: 'new-user@example.com', Password: ${JSON.stringify(NEW.password)}}, {observe: true});
const before = await page.evaluate(() => document.querySelectorAll('input[type=password]').length);
await page.getByRole('button', {name: 'Create account'}).click();
console.log('VAULT ' + JSON.stringify({before, out: await page.evaluate(() => document.getElementById('out').textContent)}));
`);
      assert.ok(!saved.stdout.includes(NEW.password), "a password reached the output");
      const after = JSON.parse(/VAULT (.*)/.exec(saved.stdout)?.[1] ?? "null");
      assert.ok(after, saved.stdout + saved.stderr);
      assert.equal(after.before, 2, saved.stdout);
      assert.equal(after.out, "Account created", saved.stdout);
      const state = await vault.read();
      assert.equal(state.writes.length, 1, "the login was not saved");
      assert.equal(state.writes[0].item.login.username, "new-user@example.com");
      assert.equal(state.writes[0].item.login.password, NEW.password);

      // A fill-only cell on a page whose background requests never stop: the cell must not wait
      // for a page observation. The cost is printed; the fill itself is read back.
      await cell(
        `page = await browser.openTab(${JSON.stringify(url + "busy")}); await page.waitForLoadState('domcontentloaded').catch(() => {}); await bu.state();`,
      );
      const busyBaseAt = Date.now();
      await cell("1 + 1");
      const busyBase = Date.now() - busyBaseAt;
      const busyAt = Date.now();
      const busy = await cell(`await bu.type('input[name=email]', 'busy@example.com');
        console.log('BUSYVALUE ' + await page.evaluate(() => document.querySelector('input[name=email]').value));`);
      const busyCost = Math.max(0, Date.now() - busyAt - busyBase);
      console.log("BUSYFILL " + JSON.stringify({ busyCost, busyBase }));
      assert.match(busy.stdout, /BUSYVALUE busy@example\.com/, busy.stdout);
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
      await rm(vault.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
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
