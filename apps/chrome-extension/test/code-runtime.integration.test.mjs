/* eslint-disable max-lines-per-function, complexity -- one end-to-end scenario with its fake Core */
// End to end: the built extension in real Chrome, connected to a fake Core, running browser_code cells.
import { waitForDebugPort } from "./browser-cdp-helper.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { chromeForTestingPath } from "./browser-fixture-helper.mjs";
import { BrowserRealmServer } from "@browserkit/engine/code-realm-server";

const chromePath = chromeForTestingPath();
const extension = resolve("apps/chrome-extension/native-dist");
const log = process.env.GRAFT_TEST_DEBUG
  ? (...parts) => process.stderr.write(parts.join(" ") + String.fromCharCode(10))
  : () => {};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test(
  "browser_code cells run inside the extension against real Chrome",
  {
    skip:
      existsSync(chromePath) && existsSync(extension)
        ? false
        : "Chrome for Testing or the built extension is missing",
  },
  async (t) => {
    const page = createServer((request, response) => {
      if (request.url?.startsWith("/api/orders")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            orders: [
              { id: 1, total: 42 },
              { id: 2, total: 7 },
            ],
          }),
        );
        return;
      }
      if (request.url === "/attack") {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Attack</title><p>Nothing to see</p><script>
  window.__attack = { scans: 0, attempts: 0, found: [] };
  setInterval(() => {
    window.__attack.scans += 1;
    try {
      for (const symbol of Object.getOwnPropertySymbols(window)) {
        const key = Symbol.keyFor(symbol);
        if (!key || !key.startsWith("graft.handoff.")) continue;
        window.__attack.attempts += 1;
        window.__attack.found.push(key);
        window[symbol] = { answer: "forged by the page" };
      }
    } catch (error) { window.__attack.error = String(error); }
  }, 25);
</script>`,
        );
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Fixture</title><h1>Shop</h1><input aria-label="Search"><button onclick="document.title='clicked';document.body.append(document.createElement('hr'))">Go</button><button>Nothing</button><button disabled>Disabled</button>`,
      );
    });
    await new Promise((done) => page.listen(0, "127.0.0.1", done));
    const pageUrl = `http://127.0.0.1:${page.address().port}/`;
    const core = await fakeCore();
    const profile = await mkdtemp(join(tmpdir(), "graft-code-runtime-"));
    const chrome = spawn(
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
    try {
      const port = await debugPort(profile);
      log("port", port);
      const worker = await waitForTarget(port, (item) => item.url.endsWith("/service-worker.js"));
      log("worker", worker.url);
      const cdp = await connect(worker.webSocketDebuggerUrl);
      for (let i = 0; i < 100; i++) {
        const ready = await cdp("Runtime.evaluate", {
          expression: "typeof chrome?.runtime?.id",
          returnByValue: true,
        });
        if (ready.result?.result?.value === "string") break;
        await sleep(100);
      }
      await cdp("Runtime.evaluate", {
        expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback({
          kind: "native.bootstrap.result", protocolVersion: request.protocolVersion, ok: true,
          endpoint: "ws://127.0.0.1:${core.port}/graft/v1", connectionGrant: "${"A".repeat(43)}",
          expiresAt: Date.now() + 600000, daemonProtocolVersion: request.protocolVersion });`,
      });
      log("bootstrap overridden");
      // A bootstrap that failed before the override is retried on tab activation, so opening the
      // fixture tab also wakes the connection.
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
      const browserCdp = await connect(version.webSocketDebuggerUrl);
      await browserCdp("Target.createTarget", { url: pageUrl });
      await core.connected;
      const target = await core.target(pageUrl);
      log("target", JSON.stringify(target));
      const chatId = randomUUID();
      const run = (code) => core.run({ chatId, code, targets: [target] });

      await t.test("top-level bindings, functions and the last expression persist", async () => {
        assert.equal((await run("const n = 41; function seven() { return 7 }")).error, undefined);
        assert.equal((await run("n + 1")).value, 42);
        assert.equal((await run("let {a, b: [c]} = {a: 1, b: [2]}; seven() + a + c")).value, 10);
      });

      await t.test("bu.state observes the attached page and bu.click acts on its ids", async () => {
        const state = await run("await bu.state()");
        assert.match(state.output, /button "Go"/);
        const id = /\[(\d+)\] button "Go"/.exec(state.output)[1];
        const clicked = await run(
          `await bu.click(${id}); await page.evaluate(() => document.title)`,
        );
        assert.equal(clicked.error, undefined);
        assert.equal(clicked.value, "clicked");
        assert.ok(clicked.steps.some((step) => step.action?.op === "click"));
      });

      await t.test("every input step reports a closed effect with its evidence", async () => {
        const state = await run("await bu.state()");
        const id = (name) => {
          const found = new RegExp(`\\[(\\d+)\\] button "${name}"`).exec(state.output);
          assert.ok(found, `${name} is listed:\n${state.output.slice(0, 800)}`);
          return found[1];
        };
        const field = /\[(\d+)\] textbox "Search"/.exec(state.output)[1];
        const clickStep = async (code) => {
          const result = await run(code);
          return result.steps.filter((item) => item.action?.op === "click").at(-1);
        };
        const byOp = async (op, code) => {
          const result = await run(code);
          assert.equal(result.error, undefined, `${code}: ${result.error}`);
          const step = result.steps.filter((item) => item.action?.op === op).at(-1);
          assert.ok(step, `${op} step missing: ${JSON.stringify(result.steps).slice(0, 1200)}`);
          return step;
        };

        const changed = await byOp("click", `await bu.click(${id("Go")})`);
        assert.equal(changed.result.effect, "confirmed");
        assert.match(changed.result.evidence, /DOM change|navigation/);

        const filled = await byOp("fill", `await bu.type(${field}, "query")`);
        assert.equal(filled.result.effect, "confirmed");
        assert.match(filled.result.evidence, /value read back: "query"/);

        const noop = await byOp("click", `await bu.click(${id("Nothing")})`);
        assert.equal(noop.result.effect, "suspected_noop", noop.result.evidence);
        assert.match(noop.result.evidence, /no navigation, DOM change or request/);
        assert.match(String(noop.result.note), /nothing happened/);

        // A step the engine refused never ran: refused, with its code as the evidence.
        const refused = await clickStep(
          `try { await bu.click(${id("Disabled")}) } catch (error) { String(error.message).split("\\n")[0] }`,
        );
        assert.equal(refused.disposition, "failed");
        assert.equal(refused.effect, "refused");
        assert.equal(refused.evidence, "TARGET_DISABLED");
      });

      await t.test("the agent cursor appears without entering the page state", async () => {
        const result = await run(
          "await new Promise((r) => setTimeout(r, 50)); [typeof document, await page.evaluate(() => [...document.documentElement.children].some((n) => n.style.zIndex === '2147483647' && n.style.contain === 'strict'))]",
        );
        assert.deepEqual(result.value, ["undefined", true]);
        assert.doesNotMatch((await run("await bu.state()")).output, /graft-agent-cursor/);
        const globals = await run(
          "await page.evaluate(() => Object.getOwnPropertyNames(window).filter((name) => /^(__graft|__browserkit|__ux|browserkit-)/.test(name)))",
        );
        assert.deepEqual(globals.value, [], "the extension left a page global behind");
      });

      await t.test("labeled screenshots place ids on the elements and clean up", async () => {
        const result = await run(`
          await page.evaluate(() => { document.body.style.height = '3000px'; scrollTo(0, 400); });
          const id = /\\[(\\d+)\\] button "Go"/.exec(await bu.state()).at(1);
          const box = (await page.cdp('DOM.getBoxModel', { backendNodeId: Number(id) })).model.border;
          const rect = await page.evaluate(() => document.querySelector('button').getBoundingClientRect().top);
          const shot = await page.screenshot({ labels: true });
          [Math.round(Math.min(box[1], box[3])) === Math.round(rect), shot.kind, await page.evaluate(() => !!document.getElementById('graft-labels'))]`);
        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, [true, "screenshot", false]);
      });

      await t.test("a saved site skill is offered and loads in another chat", async () => {
        const saved = await run(
          "await skills.save({name: 'shop-title', domains: ['127.0.0.1'], description: 'Reads the shop title', code: \"var shop = {title: () => page.evaluate(() => document.title)}\"})",
        );
        assert.equal(saved.error, undefined);
        const other = (code) => core.run({ chatId: otherChat, code, targets: [] });
        const otherChat = randomUUID();
        const listed = await other(
          `page = await browser.openTab(${JSON.stringify(pageUrl)}); await bu.state()`,
        );
        assert.match(
          listed.output,
          /Site skills .*shop-title/,
          JSON.stringify(listed).slice(0, 400),
        );
        const used = await other("await skills.load('shop-title'); await shop.title()");
        assert.equal(used.error, undefined);
        assert.equal(used.value, "Fixture");
      });

      const openExtensionPage = async () => {
        const match = (item) => item.url.endsWith("/sidepanel.html");
        const existing = (
          await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
        ).find(match);
        if (existing) return existing;
        await cdp("Runtime.evaluate", {
          expression:
            "chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: false })",
          awaitPromise: true,
        });
        return waitForTarget(port, match);
      };

      await t.test("work in a background tab publishes a live preview", async () => {
        const panel = await openExtensionPage();
        const listener = await connect(panel.webSocketDebuggerUrl);
        await listener("Runtime.evaluate", {
          expression:
            "globalThis.previews = []; chrome.runtime.onMessage.addListener((m) => { if (m?.kind === 'graft.browser.preview') previews.push(!!m.image); })",
        });
        const chat = randomUUID();
        const opened = await core.run({
          chatId: chat,
          code: `page = await browser.openTab(${JSON.stringify(pageUrl)}); await page.evaluate(() => document.title)`,
          targets: [],
        });
        assert.equal(opened.error, undefined);
        let frames = [];
        for (let i = 0; i < 40 && !frames.includes(true); i++) {
          await sleep(100);
          frames = (
            await listener("Runtime.evaluate", { expression: "previews", returnByValue: true })
          ).result.result.value;
        }
        assert.ok(frames.includes(true), JSON.stringify(frames));
      });

      await t.test("a hand-off waits for the user, pausing Core's deadline", async () => {
        const pending = run("await bu.handoff('Sign in to continue'); 'resumed'");
        const banner = await handoffPage(port, pageUrl);
        assert.deepEqual(core.waiting, [true]);
        await banner.answer("done");
        const result = await pending;
        assert.equal(result.error, undefined);
        assert.equal(result.value, "resumed");
        assert.deepEqual(core.waiting, [true, false]);
        assert.ok(result.steps.some((step) => step.action?.op === "handoff"));
        assert.equal(await banner.present(), false);

        const cancelled = run("await bu.handoff('Pick a seat')");
        await (await handoffPage(port, pageUrl)).answer("cancelled");
        assert.match((await cancelled).error, /HANDOFF_CANCELLED/);

        // The chat's hand-off card answers through a runtime message instead of the banner.
        const fromChat = run("await bu.handoff('Approve the order'); 'approved'");
        await handoffPage(port, pageUrl);
        const extensionPage = await openExtensionPage();
        const sender = await connect(extensionPage.webSocketDebuggerUrl);
        await sender("Runtime.evaluate", {
          expression: `chrome.runtime.sendMessage({ kind: "graft.handoff.answer", tabId: ${target.tabId}, answer: "done" })`,
        });
        assert.equal((await fromChat).value, "approved");
      });

      await t.test("a page cannot read or answer the hand-off", async () => {
        const attackUrl = pageUrl + "attack";
        const chat = randomUUID();
        const secret = "s3cret-code-47";
        const pending = core.run({
          chatId: chat,
          code: `page = await browser.openTab(${JSON.stringify(attackUrl)}); await bu.handoff('Type the code')`,
          targets: [],
        });
        const ask = await handoffPage(port, attackUrl);
        const early = await Promise.race([
          pending.then((result) => ({ state: "settled", result })),
          sleep(1200).then(() => ({ state: "waiting" })),
        ]);
        assert.equal(
          early.state,
          "waiting",
          `the page answered for the user: ${JSON.stringify(early)}`,
        );
        await ask.type(secret);
        const probe = await ask.evaluate(`(() => ({
          symbols: Object.getOwnPropertySymbols(window).map((symbol) => {
            let value; try { value = globalThis[symbol]; } catch {}
            return [Symbol.keyFor(symbol) || String(symbol), typeof value === "object" ? JSON.stringify(value) : String(value)];
          }),
          inputs: [...document.querySelectorAll("input")].map((input) => input.value),
          shadow: document.getElementById("graft-agent-ask")?.shadowRoot ? "open" : "closed",
          text: document.body.innerText
        }))()`);
        assert.equal(
          JSON.stringify(probe).includes(secret),
          false,
          "the page could read the typed answer",
        );
        const attack = await ask.evaluate("window.__attack");
        assert.ok(attack.scans > 0, "the page never scanned for a hand-off key");
        assert.equal(
          attack.attempts,
          0,
          `the page found a hand-off key: ${JSON.stringify(attack.found)}`,
        );
        await ask.answer("done");
        const result = await pending;
        assert.equal(result.error, undefined);
        assert.equal(result.value, secret, "the cell got the user's answer, not the page's");
      });

      await t.test("network recording finds a site's JSON API and fetchJson calls it", async () => {
        const learned = await run(`
          await page.network.start();
          await page.evaluate(() => fetch('/api/orders?page=1').then((r) => r.json()));
          await page.waitFor(() => true);
          let calls = [];
          for (let i = 0; i < 20 && !calls.some((c) => c.status); i++) {
            calls = await page.network.list('/api/');
            await new Promise((r) => setTimeout(r, 50));
          }
          const body = await page.network.body(calls[0].id);
          await page.network.stop();
          [calls.length, calls[0].method, calls[0].json, body.orders.length]`);
        assert.equal(learned.error, undefined);
        assert.deepEqual(learned.value, [1, "GET", true, 2]);
        const direct = await run("(await page.fetchJson('/api/orders?page=2')).orders[0].total");
        assert.equal(direct.value, 42);
        // A stopped recording stays readable (and savable) until the next start.
        assert.equal((await run("(await page.network.list('/api/')).length")).value, 1);
      });

      await t.test("the CLI's block list is the extension's settings list", async () => {
        const added = await core.blockedSites("add", "bank.example");
        assert.deepEqual(added.sites, ["bank.example"], JSON.stringify(added));
        const read = await core.blockedSites("read");
        assert.deepEqual(read.sites, ["bank.example"]);
        const stored = await cdp("Runtime.evaluate", {
          expression: "chrome.storage.local.get('blocked-sites').then((v) => v['blocked-sites'])",
          awaitPromise: true,
          returnByValue: true,
        });
        assert.deepEqual(stored.result.result.value, ["bank.example"]);
        const removed = await core.blockedSites("remove", "bank.example");
        assert.deepEqual(removed.sites, []);
      });

      await t.test("workspace calls are served by Core", async () => {
        const result = await run("await checkpoint('progress.json', {done: 3})");
        assert.equal(result.error, undefined);
        // The cell's closing observation asks for site rules after the checkpoint; what this
        // test owns is that Core served the workspace call with its name and value.
        assert.deepEqual(core.calls.filter((call) => call.workspace === "checkpoint").at(-1), {
          workspace: "checkpoint",
          name: "progress.json",
          value: { done: 3 },
        });
      });

      await t.test("errors report without breaking the realm", async () => {
        assert.match((await run("this is not javascript")).error, /SyntaxError|Unexpected/);
        assert.match((await run("await page.cdp('Target.getTargets')")).error, /UNSUPPORTED/);
        assert.equal((await run("n")).value, 41);
      });

      await t.test("page calls stay inside the browser", async () => {
        // The average is reported, never asserted: wall-clock time says nothing about correctness
        // and a shared, busy machine can make any fixed budget flaky. A speed regression belongs
        // in a benchmark, not in this suite.
        const measured = await run(
          "const t0 = performance.now(), answers = []; for (let i = 0; i < 50; i++) answers.push(await page.evaluate(() => 1)); ({ms: (performance.now() - t0) / 50, answers})",
        );
        assert.equal(measured.error, undefined);
        assert.deepEqual(
          measured.value.answers,
          Array(50).fill(1),
          "every round trip answers from the page",
        );
        t.diagnostic(`page.evaluate round trip: ${measured.value.ms.toFixed(2)} ms`);
      });
    } finally {
      chrome.kill();
      core.close();
      page.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
);

async function fakeCore() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/graft/v1" });
  await new Promise((done) => server.once("listening", done));
  let socket,
    tabs = [];
  const results = new Map();
  const calls = [];
  const waiting = [];
  const skills = new Map();
  const blocked = new Map();
  // browser_code realms run in the local process, as in the daemon and the bridge.
  const realms = new BrowserRealmServer();
  const connected = new Promise((done) =>
    server.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (realms.handle(message, ws)) return;
        log("core <-", message.kind, message.error ?? "");
        if (message.kind === "auth.hello")
          ws.send(
            JSON.stringify({
              kind: "auth.ready",
              protocolVersion: message.protocolVersion,
              role: "extension-executor",
              connectionId: randomUUID(),
            }),
          );
        else if (message.kind === "browser.inventory.full") {
          tabs = message.tabs;
          log("inventory", JSON.stringify(message.tabs.map((tab) => tab.url)));
          ws.send(
            JSON.stringify({
              kind: "browser.inventory.applied",
              generation: message.generation,
              lastSequence: 0,
            }),
          );
          done();
        } else if (message.kind === "browser.inventory.delta") {
          log("delta", JSON.stringify(message.delta).slice(0, 200));
          if (message.delta.kind === "tab.upsert")
            tabs = [
              ...tabs.filter((tab) => tab.target.tabId !== message.delta.tab.target.tabId),
              message.delta.tab,
            ];
          ws.send(
            JSON.stringify({
              kind: "browser.inventory.applied",
              generation: message.generation,
              lastSequence: message.sequence,
            }),
          );
        } else if (message.kind === "browser.executor.heartbeat")
          ws.send(
            JSON.stringify({
              kind: "browser.executor.heartbeat.ack",
              clientInstanceId: message.clientInstanceId,
              browserRunId: message.browserRunId,
            }),
          );
        else if (message.kind === "browser.code.call") {
          calls.push(message.request);
          if (message.request.siteSkill) {
            const request = message.request;
            const value =
              request.siteSkill === "save"
                ? (skills.set(request.skill.name, request.skill), { saved: request.skill.name })
                : request.siteSkill === "get"
                  ? skills.get(request.name)
                  : [...skills.values()].map(({ name, description }) => ({ name, description }));
            ws.send(
              JSON.stringify({
                kind: "browser.code.reply",
                cellId: message.cellId,
                callId: message.callId,
                value,
              }),
            );
            return;
          }
          ws.send(
            JSON.stringify({
              kind: "browser.code.reply",
              cellId: message.cellId,
              callId: message.callId,
              value: { path: "C:/workspace/" + message.request.name },
            }),
          );
        } else if (message.kind === "browser.code.progress") {
          if (message.waitingForUser !== undefined) waiting.push(message.waitingForUser);
        } else if (message.kind === "native.blocked-sites.result") {
          blocked.get(message.requestId)?.(message);
        } else if (message.kind === "browser.code.result") results.get(message.cellId)?.(message);
      });
    }),
  );
  return {
    port: server.address().port,
    calls,
    waiting,
    connected,
    async target(url) {
      for (let i = 0; i < 80; i++) {
        const tab = tabs.find((item) => item.url === url && item.status === "complete");
        if (tab) return tab.target;
        await sleep(100);
      }
      throw new Error("Fixture tab never appeared in the inventory");
    },
    run({ chatId, code, targets }) {
      const cellId = randomUUID();
      const result = new Promise((done) => results.set(cellId, done));
      socket.send(
        JSON.stringify({
          kind: "browser.code.run",
          cellId,
          chatId,
          toolCallId: "test",
          code,
          targets,
          timeoutMs: 20000,
        }),
      );
      return Promise.race([result, sleep(25000).then(() => ({ error: "test timeout" }))]);
    },
    blockedSites(action, site) {
      const requestId = randomUUID();
      const result = new Promise((done) => blocked.set(requestId, done));
      socket.send(
        JSON.stringify({
          kind: "native.blocked-sites",
          requestId,
          action,
          ...(site ? { site } : {}),
        }),
      );
      return Promise.race([result, sleep(10000).then(() => ({ error: "blocked sites timeout" }))]);
    },
    close: () => (server.close(), realms.close()),
  };
}

// Finds the fixture tab waiting on a hand-off (the isolated-world ask) and acts as the user would.
async function handoffPage(port, url) {
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    for (const item of targets.filter((entry) => entry.type === "page" && entry.url === url)) {
      const page = await connect(item.webSocketDebuggerUrl);
      const present = async () =>
        (
          await page("Runtime.evaluate", {
            expression: `Boolean(document.getElementById("graft-agent-ask"))`,
            returnByValue: true,
          })
        ).result?.result?.value === true;
      if (!(await present())) continue;
      return {
        present,
        type: async (text) => {
          const nodes = await askNodes(page);
          await callOnNode(
            page,
            nodes.input,
            "function (value) { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); }",
            [text],
          );
        },
        answer: async (state) => {
          const nodes = await askNodes(page);
          if (state === "cancelled")
            return callOnNode(page, nodes.cancel, "function () { this.click(); }");
          if (state && typeof state === "object" && typeof state.answer === "string") {
            await callOnNode(
              page,
              nodes.input,
              "function (value) { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); }",
              [state.answer],
            );
          }
          return callOnNode(page, nodes.done, "function () { this.click(); }");
        },
        evaluate: async (expression) =>
          (
            await page("Runtime.evaluate", {
              expression,
              returnByValue: true,
              awaitPromise: true,
            })
          ).result?.result?.value,
      };
    }
    await sleep(100);
  }
  throw new Error("Hand-off never appeared");
}

/** The ask's input and buttons, including inside its closed shadow root. */
async function askNodes(page) {
  const document = await page("DOM.getDocument", { depth: -1, pierce: true });
  const nodes = {};
  walkAsk(document.result?.root, false);
  if (!nodes.input || !nodes.done) throw new Error("Hand-off ask has no field or Done");
  return nodes;
  function walkAsk(node, inAsk) {
    if (!node) return;
    const attributes = node.attributes ?? [];
    const pair = (name) => {
      const index = attributes.indexOf(name);
      return index >= 0 ? attributes[index + 1] : undefined;
    };
    const here = inAsk || (pair("id") === "graft-agent-ask" && node.nodeName === "DIV");
    const classes = (pair("class") ?? "").split(/\s+/);
    if (here && node.nodeName === "INPUT") nodes.input = node;
    if (here && node.nodeName === "BUTTON" && classes.includes("done")) nodes.done = node;
    if (here && node.nodeName === "BUTTON" && classes.includes("cancel")) nodes.cancel = node;
    for (const child of node.children ?? []) walkAsk(child, here);
    for (const root of node.shadowRoots ?? []) walkAsk(root, here);
  }
}

async function callOnNode(page, node, functionDeclaration, args = []) {
  if (!node) throw new Error("Hand-off node not found");
  const resolved = await page("DOM.resolveNode", { backendNodeId: node.backendNodeId });
  const objectId = resolved.result?.object?.objectId;
  if (!objectId) throw new Error("Hand-off node not resolvable");
  await page("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
  });
}

async function debugPort(profile) {
  return Number(await waitForDebugPort(profile));
}

async function waitForTarget(port, match) {
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (r) => r.json(),
      () => [],
    );
    const found = targets.find(match);
    if (found) return found;
    await sleep(100);
  }
  throw new Error("Target not found");
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  return new Promise((ready) => {
    ws.onopen = () =>
      ready(
        (method, params = {}) =>
          new Promise((done) => {
            waiting.set(++id, done);
            ws.send(JSON.stringify({ id, method, params }));
          }),
      );
  });
}
