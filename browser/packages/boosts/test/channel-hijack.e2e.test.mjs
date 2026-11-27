// A hostile page tries to drive a boost's private channel to read another site with the person's
// cookies. Real Chrome, User Scripts on, two real local origins: Site A (127.0.0.1) holds a
// cookie-gated secret, Site B (localhost) is the hostile page. No request from the attack may
// ever reach Site A's /secret, whether the boost runs isolated (the default) or in the page world.
// Real Chrome: CHROME_PATH=<chrome-for-testing 157> CI=1 node --test test/channel-hijack.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromePort } from "../../../test/helpers/chrome-port.mjs";
import { userScriptsOn } from "../../../test/helpers/user-scripts-on.mjs";

const browserRoot = fileURLToPath(new URL("../../../", import.meta.url));
const WebSocket = createRequire(join(browserRoot, "package.json"))("ws");
const chromePath =
  process.env.CHROME_PATH ??
  join(browserRoot, "../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = join(browserRoot, "apps/extension/build");
const cli = join(browserRoot, "apps/bridge/dist/cli.js");
const EXT_ID = "dmlgohfphkbenjopdphcojgjeidlmajj";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);
const J = JSON.stringify;

// Patches dispatchEvent before any boost runs, steals the channel name of a page-world boost and
// asks it for a GET of `?t=` with the person's cookies.
const EVIL = `<title>Evil</title><h1>evil</h1><script>
window.__stolen = null; window.__loot = []; const target = new URLSearchParams(location.search).get('t');
const orig = EventTarget.prototype.dispatchEvent;
EventTarget.prototype.dispatchEvent = function (e) {
  if (!window.__stolen && typeof e.type === 'string' && /^sb-.*-up$/.test(e.type)) {
    window.__stolen = e.type;
    document.addEventListener(e.type.replace(/-up$/, '-down'), (ev) => window.__loot.push(String(ev.detail).slice(0, 2000)));
    setTimeout(() => {
      for (const [id, op, args] of [[900001, 'xhr', { method: 'GET', url: target }], [900002, 'values.set', { key: 'k', value: 1 }], [900003, 'tab.open', { url: target }]])
        orig.call(document, new CustomEvent(e.type, { detail: JSON.stringify({ t: 'call', id, op, stream: op === 'xhr', args }) }));
    }, 300);
  }
  return orig.call(this, e);
};
</script>`;

function sites() {
  const hits = { secret: 0, data: 0 };
  const a = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const cookie = req.headers.cookie ?? "";
    if (path === "/login") {
      res.setHeader("set-cookie", "sid=SECRET-A; Path=/; HttpOnly; SameSite=Lax");
      return res.end("logged in");
    }
    if (path === "/secret") hits.secret += 1;
    if (path === "/data") hits.data += 1;
    res.setHeader("content-type", "application/json");
    res.end(J({ secret: cookie.includes("SECRET-A") ? "BANK-BALANCE-9001" : "no-cookie" }));
  });
  const b = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const path = new URL(req.url, "http://x").pathname;
    res.end(path === "/evil" ? EVIL : "<title>B</title><h1>B</h1>");
  });
  return { a, b, hits };
}

const listen = (server) =>
  new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));

test(
  "a hostile page cannot use a boost's channel to read another site with the person's cookies",
  {
    skip:
      !process.env.CI &&
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const { a, b, hits } = sites();
    const A = `http://127.0.0.1:${await listen(a)}`;
    const B = `http://localhost:${await listen(b)}`;
    const rig = await boot();
    try {
      assert.equal(await userScriptsOn(rig.browser, EXT_ID), "ok");
      await rig.cell(probe(`${A}/login`, "() => 1"));
      const cases = [
        { name: "isolated by default", world: undefined },
        { name: "page world (opt-in)", world: "page" },
      ];
      for (const { name, world } of cases) {
        await rig.cell(
          `await browser.boosts.save(${J({ name, sites: ["localhost"], js: "document.title = 'boosted ' + document.title", ...(world ? { jsWorld: world } : {}) })}); console.log("R 1")`,
        );
        const evil = await rig.cell(
          probe(
            `${B}/evil?t=${encodeURIComponent(A + "/secret")}`,
            "() => ({ title: document.title, stolen: window.__stolen, loot: window.__loot })",
            3500,
          ),
        );
        assert.match(String(evil.title), /boosted/, `${name}: the boost still runs`);
        assert.doesNotMatch(J(evil.loot), /BANK-BALANCE|no-cookie/, `${name}: nothing read`);
        assert.equal(hits.secret, 0, `${name}: no request reached /secret`);
        if (world === "page") {
          assert.ok(evil.stolen, "the page world channel is visible to the page");
          assert.match(J(evil.loot), /PAGE_WORLD_LIMITED/, "the bridge refuses with a reason");
        } else assert.equal(evil.stolen, null, "an isolated boost has no page channel at all");
        await rig.cell(
          `for (const x of await browser.boosts.list()) await browser.boosts.remove(x.id); console.log("R 1")`,
        );
      }
      // The trusted isolated world keeps its cross-site GM.xmlHttpRequest.
      await rig.cell(
        `await browser.boosts.save(${J({ name: "feed", sites: ["localhost"], js: `GM.xmlHttpRequest({ url: ${J(A + "/data")}, onload: (r) => (document.body.dataset.got = r.responseText) })` })}); console.log("R 1")`,
      );
      const feed = await rig.cell(
        probe(`${B}/plain`, "() => document.body.dataset.got ?? null", 3000),
      );
      assert.match(String(feed), /BANK-BALANCE/, J(feed));
      assert.equal(hits.data, 1);
    } finally {
      await rig.stop();
      a.close();
      b.close();
    }
  },
);

function probe(url, fn, wait = 1500) {
  return `const page = await browser.openTab(${J(url)}, {newTab: true});
    await new Promise((r) => setTimeout(r, ${wait}));
    const out = await page.evaluate(${fn});
    await browser.closeTab(page);
    console.log("R " + JSON.stringify(out));`;
}

async function boot() {
  const home = await mkdtemp(join(tmpdir(), "hijack-home-"));
  const profile = await mkdtemp(join(tmpdir(), "hijack-chrome-"));
  const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
  const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
  let chrome;
  const stop = async () => {
    chrome?.kill();
    bridge.kill();
    await sleep(300);
    for (const dir of [profile, home])
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
  };
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
    const browser = await connectExtension(profile, env);
    const cell = async (code) => {
      const { stdout } = await run(process.execPath, [cli, "repl", "--session", "hijack", code], {
        env,
        timeout: 90_000,
        maxBuffer: 1 << 24,
      });
      const match = /^R (.*)$/m.exec(stdout);
      assert.ok(match, stdout);
      return JSON.parse(match[1]);
    };
    return { browser, cell, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  }, 60000);
  const reply = await nativeBootstrap(env);
  const sw = connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await sw("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await sw("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, _request, callback) => callback(${J(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return browser;
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(process.execPath, [cli, `chrome-extension://${EXT_ID}/`], { env });
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      J({
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
  return async (method, params = {}, sessionId) => {
    await opened;
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(J({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
}
