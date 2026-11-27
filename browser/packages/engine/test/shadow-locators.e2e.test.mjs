// Real Chrome: Playwright-style locators pierce open shadow roots and custom-element hosts the
// way fillForm and page.batch do (getByLabel, getByRole, locator(css).first() on a host whose box
// lives in its shadow root), so a web-component page resolves the same through every path.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { browserPlaywrightApi } from "../dist/code-api-playwright.js";

const chromePath = process.env.CHROME_PATH ?? "";

const PAGE = `<!doctype html><body>
<sl-like id="one" label="Select one"></sl-like>
<sl-like id="two" label="Pick two"></sl-like>
<day-grid></day-grid>
<script>
customElements.define('sl-like', class extends HTMLElement { connectedCallback() {
  this.style.display = 'contents';
  var root = this.attachShadow({mode: 'open'});
  root.innerHTML = '<label id="l" part="label"></label><div role="combobox" aria-labelledby="l" tabindex="0" style="display:block;width:120px;height:24px;background:#ccc"></div><input aria-label="Inner field">';
  root.getElementById('l').textContent = this.getAttribute('label');
  root.querySelector('[role=combobox]').addEventListener('click', () => { this.dataset.clicked = '1'; });
} });
customElements.define('day-grid', class extends HTMLElement { connectedCallback() {
  var outer = this.attachShadow({mode: 'open'});
  outer.innerHTML = '<div><nested-days></nested-days></div>';
} });
customElements.define('nested-days', class extends HTMLElement { connectedCallback() {
  var root = this.attachShadow({mode: 'open'});
  root.innerHTML = '<button aria-label="Friday, November 20th, 2026">20</button>';
} });
</script>`;

// The page-side helpers run as the engine runs them: their source, assembled in the page.
const helpers = (name) => {
  const start = browserPlaywrightApi.indexOf(`function ${name}(`);
  const next = browserPlaywrightApi.indexOf("\nfunction ", start + 1);
  return browserPlaywrightApi.slice(start, next);
};

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => (socket.once("open", done), socket.once("error", fail)));
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const send = (method, params = {}) =>
    new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

test(
  "locators pierce open shadow roots and custom-element hosts",
  { skip: !process.env.REQUIRE_E2E && !(chromePath && existsSync(chromePath)) },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "graft-shadow-locators-"));
    const chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--headless=new",
        "--no-first-run",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      const endpoint = await new Promise((done) => {
        let text = "";
        chrome.stderr.on("data", (chunk) => {
          text += chunk;
          const found = /ws:\/\/\S+/.exec(text);
          if (found) done(found[0]);
        });
      });
      const port = new URL(endpoint).port;
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = await cdp(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
      await page.send("Page.enable");
      await page.send("Page.navigate", { url: "data:text/html," + encodeURIComponent(PAGE) });
      await new Promise((done) => setTimeout(done, 500));
      const evaluate = async (body) => {
        const expression = `(() => { ${helpers("__resolveInPage")}\n${helpers("__pickInPage")}\n${body} })()`;
        const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true });
        assert.equal(reply.result.exceptionDetails, undefined, JSON.stringify(reply.result));
        return reply.result.result.value;
      };
      const label = await evaluate(
        "return __resolveInPage({by: 'label', value: 'Select one'}).map((el) => el.getAttribute('role'));",
      );
      assert.deepEqual(label, ["combobox"]);
      assert.equal(
        await evaluate("return __resolveInPage({by: 'label', value: 'Inner field'}).length;"),
        2,
      );
      const day = await evaluate(
        "return __resolveInPage({role: 'button', name: 'Friday, November 20th, 2026'}).length;",
      );
      assert.equal(day, 1);
      assert.equal(
        await evaluate("return __resolveInPage({by: 'css', value: 'sl-like'}).length;"),
        2,
      );
      // first() on a display: contents host picks the box its shadow root draws.
      const box = await evaluate(
        "return __pickInPage(__resolveInPage({by: 'css', value: 'sl-like'}), {index: 0, visibleFirst: true});",
      );
      assert.ok(box.x > 0 && box.y > 0, JSON.stringify(box));
      page.close();
    } finally {
      chrome.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  },
);
