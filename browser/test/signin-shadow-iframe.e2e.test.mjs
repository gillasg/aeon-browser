// End to end: bu.signIn() on forms where real sites put them (an open shadow root, a same-origin
// iframe, a frame of another origin on the same site), refusing a frame of another site, a form
// that does not react, and the page handle staying usable after a failed sign-in. Real Chrome,
// the built extension, a fake `bw` and the bridge CLI; local pages and fake passwords only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { SIGNIN, fakeVaultFor, signinRoutes } from "./signin-site.mjs";
import { chromePort } from "./helpers/chrome-port.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
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

const result = (stdout, marker) => {
  const found = new RegExp(marker + " (.*)").exec(stdout);
  assert.ok(found, stdout);
  return JSON.parse(found[1]);
};

test(
  "bu.signIn finds forms in shadow roots and frames and keeps the page handle",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async (t) => {
    const seen = [];
    const site = createServer((request, response) => {
      if (signinRoutes(seen)(request, response)) return;
      response.setHeader("content-type", "text/html");
      response.end("<title>Fixture</title><p>fixture</p>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const port = site.address().port;
    const vault = await fakeVaultFor(["127.0.0.1", "www.app.localhost"]);
    const home = await mkdtemp(join(tmpdir(), "signin-home-"));
    await writeFile(
      join(home, "password-manager.json"),
      JSON.stringify({ provider: "bitwarden", bitwardenSession: "test" }),
    );
    const env = {
      ...process.env,
      PATH: vault + delimiter + process.env.PATH,
      BROWSER_USE_EXTENSION_HOME: home,
      SITE_TO_API_HOME: join(home, "site-to-api"),
    };
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "signin-chrome-"));
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
      const signIn = async (url, after = "") => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "signin",
            "--timeout",
            "60000",
            `page = await browser.openTab(${JSON.stringify(url)}, { newTab: true });
            await page.waitForTimeout(500);
            const result = await bu.signIn();
            console.log("SIGNIN " + JSON.stringify(result));
            ${after}
            console.log("RESULT " + JSON.stringify({ result, title: await page.title(), extra: typeof extra === "undefined" ? null : extra }))`,
          ],
          { env },
        );
        assert.ok(!stdout.includes(SIGNIN.password), "the password never reaches agent output");
        return result(stdout, "RESULT");
      };
      const at = (path, host = "127.0.0.1") => `http://${host}:${port}${path}`;

      await t.test("a form in an open shadow root signs in", async () => {
        seen.length = 0;
        const { result: answer, title } = await signIn(at("/signin/shadow"));
        assert.equal(answer.signedIn, true, JSON.stringify(answer));
        assert.equal(title, "Account");
        assert.deepEqual(seen, [
          { host: "127.0.0.1", email: SIGNIN.username, password: SIGNIN.password },
        ]);
      });

      await t.test("a form in a same-origin iframe signs in", async () => {
        seen.length = 0;
        const { result: answer } = await signIn(at("/signin/iframe"));
        assert.equal(answer.signedIn, true, JSON.stringify(answer));
        assert.equal(seen.length, 1);
        assert.equal(seen[0].password, SIGNIN.password);
      });

      await t.test("a form in a cross-origin frame of the same site signs in", async () => {
        seen.length = 0;
        const { result: answer } = await signIn(at("/signin/auth-frame", "www.app.localhost"));
        assert.equal(answer.signedIn, true, JSON.stringify(answer));
        assert.deepEqual(seen, [
          { host: "auth.app.localhost", email: SIGNIN.username, password: SIGNIN.password },
        ]);
      });

      await t.test("a form in another site's frame gets nothing", async () => {
        seen.length = 0;
        const { result: answer } = await signIn(at("/signin/other-site-frame"));
        assert.equal(answer.signedIn, false);
        assert.equal(answer.reason, "FOREIGN_FORM", JSON.stringify(answer));
        assert.deepEqual(seen, []);
      });

      await t.test(
        "a form that does not react is SUBMIT_NO_EFFECT and keeps the email",
        async () => {
          const { result: answer, extra } = await signIn(
            at("/signin/dead"),
            `var extra = await page.evaluate(() => document.querySelector("input[type=email]").value);`,
          );
          assert.equal(answer.reason, "SUBMIT_NO_EFFECT", JSON.stringify(answer));
          assert.match(answer.detail, /didn't react/);
          assert.equal(extra, SIGNIN.username);
        },
      );

      await t.test("the page handle stays bound after a failed sign-in", async () => {
        for (const path of ["/signin/plain", "/signin/dead"]) {
          const { result: answer, extra } = await signIn(
            at(path),
            `var extra = await page.evaluate(() => location.pathname);`,
          );
          assert.equal(answer.signedIn, false, JSON.stringify(answer));
          assert.equal(extra, path);
        }
      });
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(300);
      for (const dir of [profile, home, vault])
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
          () => {},
        );
    }
  },
);

async function waitFor(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(250);
    }
  }
  throw last ?? new Error("timed out");
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
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await cdp("Runtime.enable").catch(() => undefined);
  await cdp("Log.enable").catch(() => undefined);
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
  }, 30_000);
  return cdp;
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
    header.writeUInt32LE(body.length);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

function connect(url, onEvent) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id === undefined) {
      onEvent?.(message);
      return;
    }
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
