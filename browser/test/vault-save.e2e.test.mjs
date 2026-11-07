// End to end: the password-save flow on pages that behave like real sites do (instant, slow,
// refusing, a code step, an app that swaps the screen, remembered accounts), in real Chrome with
// the built extension, a fake `bw` recording what a save sent, and the bridge CLI. The pages are
// local and the passwords are fake: no real site and no real vault are touched.
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
import { fakeVault, NEW, SAVED, vaultRoutes } from "./vault-site.mjs";

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

const result = (stdout, marker) => {
  const found = new RegExp(marker + " (.*)").exec(stdout);
  assert.ok(found, stdout);
  return JSON.parse(found[1]);
};

test(
  "a password the agent typed is saved only when the site took it",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async (t) => {
    const vault = await fakeVault();
    const home = await mkdtemp(join(tmpdir(), "vault-home-"));
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
      if (vaultRoutes(request, response)) return;
      response.setHeader("content-type", "text/html");
      response.end("<title>Fixture</title><p>fixture</p>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${site.address().port}`;
    const url = (path) => base + path;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "vault-chrome-"));
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

      const cell = async (code, session = "vault") => {
        const result = await run(
          process.execPath,
          [cli, "repl", "--session", session, "--timeout", "60000", code],
          { env },
        );
        // A password never reaches the output of a run, whatever the page did.
        for (const secret of [NEW.password, SAVED.password, "fake-stale-Passw0rd!"])
          assert.ok(!result.stdout.includes(secret), "a password reached the output");
        return result;
      };
      // VAULT_ONLY=<part of a name> runs just that page while a fixture is being worked on.
      const focused = process.env.VAULT_ONLY;
      const sub = (name, fn) =>
        focused && !name.includes(focused) ? Promise.resolve() : t.test(name, fn);
      const writes = async () => (await vault.read()).writes;
      const savedLogins = async () =>
        (await writes()).map((write) => ({
          username: write.item.login?.username,
          password: write.item.login?.password,
          host: new URL(write.item.login?.uris?.[0]?.uri ?? "http://x").hostname,
        }));
      const noWrites = async () => {
        // The submitting click waits for the page's answer, so the decision is made when it returns.
        await sleep(500);
        assert.deepEqual(await writes(), []);
      };
      const fillAndSubmit = (
        target,
        submit = "await page.getByRole('button', { name: 'Continue' }).click()",
      ) => `
        page = await browser.openTab(${JSON.stringify(target)}, { newTab: true });
        await page.getByLabel("Email").fill(${JSON.stringify(NEW.username)});
        await page.locator("#password").fill(${JSON.stringify(NEW.password)});
        ${submit};
        await page.title()`;

      await sub("an instant success is saved", async () => {
        await vault.reset();
        const { stdout } = await cell(fillAndSubmit(url("/vault/instant")));
        assert.match(stdout, /Account created|Welcome/, stdout);
        assert.doesNotMatch(
          stdout,
          new RegExp(NEW.password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        assert.deepEqual(await savedLogins(), [
          { username: NEW.username, password: NEW.password, host: "127.0.0.1" },
        ]);
      });

      await sub("a slow success (the form stays about three seconds) is saved", async () => {
        await vault.reset();
        const { stdout } = await cell(fillAndSubmit(url("/vault/slow")));
        assert.match(stdout, /saved/, stdout);
        await waitFor(async () => {
          assert.deepEqual(await savedLogins(), [
            { username: NEW.username, password: NEW.password, host: "127.0.0.1" },
          ]);
        }, 12_000);
      });

      await sub("a refusal (the form stays with an error) is not saved", async () => {
        await vault.reset();
        await cell(fillAndSubmit(url("/vault/refused")));
        await noWrites();
      });

      await sub("a form replaced by a code step is saved", async () => {
        await vault.reset();
        const { stdout } = await cell(fillAndSubmit(url("/vault/code-ok")));
        assert.match(stdout, /saved/, stdout);
        assert.deepEqual(await savedLogins(), [
          { username: NEW.username, password: NEW.password, host: "127.0.0.1" },
        ]);
      });

      await sub("a code step that names a refusal is not saved", async () => {
        await vault.reset();
        await cell(fillAndSubmit(url("/vault/code-refused")));
        await noWrites();
      });

      await sub("a button that does not say submit still saves", async () => {
        await vault.reset();
        const { stdout } = await cell(
          fillAndSubmit(
            url("/vault/button"),
            "await page.getByRole('button', { name: \"Let's go\" }).click()",
          ),
        );
        assert.match(stdout, /Account created/, stdout);
        assert.equal((await writes()).length, 1);
        assert.equal((await savedLogins())[0].password, NEW.password);
      });

      await sub("a pointer click on a plain button saves", async () => {
        await vault.reset();
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(url("/vault/pointer"))}, { newTab: true });
          await page.getByLabel("Email").fill(${JSON.stringify(NEW.username)});
          await page.locator("#password").fill(${JSON.stringify(NEW.password)});
          const box = await page.locator("#go").boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.title()`);
        assert.match(stdout, /Account created/, stdout);
        assert.equal((await writes()).length, 1);
        assert.equal((await savedLogins())[0].password, NEW.password);
      });

      await sub("Enter on the password field saves", async () => {
        await vault.reset();
        const { stdout } = await cell(
          fillAndSubmit(url("/vault/enter"), "await page.keyboard.press('Enter')"),
        );
        assert.match(stdout, /Account created/, stdout);
        assert.equal((await writes()).length, 1, stdout);
        assert.equal((await savedLogins())[0].password, NEW.password);
      });

      await sub("an app that removes the field without navigating saves", async () => {
        await vault.reset();
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(url("/vault/spa"))}, { newTab: true });
          await page.getByLabel("Email").fill(${JSON.stringify(NEW.username)});
          await page.locator("#password").pressSequentially(${JSON.stringify(NEW.password)});
          await page.getByRole("button", { name: "Continue" }).click();
          await page.title()`);
        assert.match(stdout, /Account created/, stdout);
        assert.equal((await writes()).length, 1, stdout);
        assert.equal((await savedLogins())[0].password, NEW.password);
      });

      await sub("a new password with a confirmation is saved once", async () => {
        await vault.reset();
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(url("/vault/confirm"))}, { newTab: true });
          await page.getByLabel("Email").fill(${JSON.stringify(NEW.username)});
          await page.locator("#password").fill(${JSON.stringify(NEW.password)});
          await page.locator("[name=confirm_password]").fill(${JSON.stringify(NEW.password)});
          await page.getByRole("button", { name: "Continue" }).click();
          await page.title()`);
        assert.match(stdout, /Account created/, stdout);
        assert.equal((await writes()).length, 1, JSON.stringify(await writes()));
        assert.equal((await savedLogins())[0].password, NEW.password);
      });

      await sub("bu.signIn passes an account chooser and signs in", async () => {
        await vault.reset([vault.login(SAVED.username, SAVED.password, url("/vault/chooser"))]);
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(url("/vault/chooser"))}, { newTab: true });
          const signed = await bu.signIn({ account: ${JSON.stringify(SAVED.username)} });
          console.log("SIGNIN " + JSON.stringify(signed));
          await page.title()`);
        const signed = result(stdout, "SIGNIN");
        assert.equal(signed.signedIn, true, stdout);
        assert.equal(signed.account, SAVED.username, stdout);
        assert.match(stdout, /Signed in/, stdout);
      });

      await sub("a refused saved login is named stale, not retried blind", async () => {
        await vault.reset([
          vault.login(SAVED.username, "fake-stale-Passw0rd!", url("/vault/chooser")),
        ]);
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(url("/vault/chooser/rejected"))}, { newTab: true });
          const signed = await bu.signIn({ account: ${JSON.stringify(SAVED.username)} });
          console.log("SIGNIN " + JSON.stringify(signed))`);
        const signed = result(stdout, "SIGNIN");
        assert.equal(signed.signedIn, false, stdout);
        assert.equal(signed.reason, "SAVED_LOGIN_REJECTED", stdout);
      });

      await sub("a locked manager offers the unlock hand-off, and Done saves it", async () => {
        await vault.reset();
        await vault.lock();
        const pending = cell(fillAndSubmit(url("/vault/instant")), "vault-locked");
        await answerHandoff(profile, url("/vault/instant"), () => vault.unlock());
        const { stdout } = await pending;
        assert.match(stdout, /unlocked it and the login was saved/, stdout);
        await waitFor(async () => {
          assert.deepEqual(await savedLogins(), [
            { username: NEW.username, password: NEW.password, host: "127.0.0.1" },
          ]);
        }, 12_000);
      });

      await sub("plain clicks still open target=_blank and window.open tabs", async () => {
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(url("/vault/popups"))}, { newTab: true });
          const before = new Set((await browser.tabs()).map((tab) => tab.id));
          await page.locator("#blank").click();
          await new Promise((done) => setTimeout(done, 1200));
          await page.locator("#win").click();
          await new Promise((done) => setTimeout(done, 1200));
          const fresh = (await browser.tabs()).filter((tab) => !before.has(tab.id)).map((tab) => tab.url);
          console.log("POPUPS " + JSON.stringify(fresh))`);
        const fresh = result(stdout, "POPUPS");
        assert.ok(
          fresh.some((tab) => tab.endsWith("/vault/popup-one")),
          stdout,
        );
        assert.ok(
          fresh.some((tab) => tab.endsWith("/vault/popup-two")),
          stdout,
        );
      });
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

// Answers the hand-off the way the cursor's Done does, from the page itself. `beforeDone` runs
// after the card is up and before Done, like a person unlocking their password manager first.
async function answerHandoff(profile, target, beforeDone) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const page = await waitFor(async () => {
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = tabs.find((tab) => tab.type === "page" && tab.url === target);
    if (!found) throw new Error("no fixture tab yet");
    return found;
  });
  const cdp = await connect(page.webSocketDebuggerUrl);
  await waitFor(async () => {
    const waiting = await cdp("Runtime.evaluate", {
      expression: "globalThis[Symbol.for('aeon.handoff')] === 'waiting'",
      returnByValue: true,
    });
    if (waiting.result?.result?.value !== true) throw new Error("hand-off not shown yet");
  }, 20_000);
  await beforeDone?.();
  await cdp("Runtime.evaluate", {
    expression: "globalThis[Symbol.for('aeon.handoff')] = 'done'",
  });
}

// Chrome only finds native hosts registered for the real browser, so the test answers the
// extension's bootstrap itself with what the native host returns (as bridge.e2e.test.mjs does).
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
