// Saved abilities replay for real in Chrome: a steps ability and a page-script ability, run from
// browser code, the browserkit CLI and a daemon-style host on its own bridge; a renamed button
// still replays (reported as adapted); a run that fails before its commit frees its write key.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { missingChrome, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const run = promisify(execFile);

function shop() {
  const state = { button: "Add to cart" };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/admin") {
      state.button = url.searchParams.get("button") ?? state.button;
      response.end("ok");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><title>Shop</title><h1>Tea</h1><label>Quantity <input id=qty value=1></label>` +
        `<button id=add>${state.button}</button><p id=cart>Cart: 0</p>` +
        `<script>add.onclick=()=>{cart.textContent='Cart: '+qty.value}</script>`,
    );
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      done({ base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, server });
    }),
  );
}

const STEPS = {
  name: "add_steps",
  kind: "write",
  description: "Add tea by its form",
  inputs: { type: "object", properties: { qty: { type: "number" } }, required: ["qty"] },
  outputs: { type: "object" },
  ways: [
    {
      kind: "steps",
      steps: [
        { kind: "fill", target: { role: "textbox", name: "Quantity" }, args: ["{qty}"] },
        { kind: "click", target: { role: "button", name: "Add to cart" } },
      ],
    },
  ],
};

const SCRIPT_CODE =
  "return await page.evaluate((qty) => { document.getElementById('qty').value = String(qty); document.getElementById('add').click(); return { cart: document.getElementById('cart').textContent }; }, inputs.qty);";

const SCRIPT = {
  name: "add_script",
  kind: "write",
  description: "Add tea with a page script",
  inputs: { type: "object", properties: { qty: { type: "number" } }, required: ["qty"] },
  outputs: { type: "object", properties: { cart: { type: "string" } } },
  ways: [{ kind: "script", runtime: "page", code: SCRIPT_CODE }],
};

/** A cell on the shop's page that runs `body` and prints its answer and the cart. */
function onShop(base, body) {
  return `const page = await browser.openTab(${JSON.stringify(base + "/")});
let out; try { out = await (async () => { ${body} })(); } catch (e) { out = { error: String(e.message) }; }
const cart = await page.evaluate(() => document.getElementById('cart').textContent);
console.log('RES ' + JSON.stringify({ out, cart })); await page.close();`;
}

function answer(output) {
  const line = /RES (.*)/.exec(output.stdout);
  assert.ok(line, output.stdout + output.stderr);
  return JSON.parse(line[1]);
}

test(
  "saved abilities replay from browser code, the CLI and a daemon host",
  { skip: missingChrome() },
  async () => {
    const site = await shop();
    const stack = await startBridgeChrome("abilities-replay");
    try {
      const cell = async (body) => answer(await stack.repl(onShop(site.base, body)));
      for (const spec of [STEPS, SCRIPT]) {
        const saved = await cell(`return saveAbility(${JSON.stringify(spec)});`);
        assert.equal(saved.out.saved, spec.name, JSON.stringify(saved));
      }

      // Browser code: both kinds change the cart, with the inputs as given ("3" becomes 3).
      const steps = await cell(`return site.run('add_steps', { qty: '3' }, { key: 's1' });`);
      assert.equal(steps.cart, "Cart: 3", JSON.stringify(steps));
      assert.equal(steps.out.write.write_status, "applied");
      const script = await cell(`return site.run('add_script', { qty: 2 }, { key: 'p1' });`);
      assert.equal(script.out.result.cart, "Cart: 2", JSON.stringify(script));

      // A missing input fails with its own code before anything runs.
      const missing = await cell(`return site.run('add_steps', {}, { key: 'm1' });`);
      assert.match(missing.out.error, /^ABILITY_INPUT: qty is required/);
      assert.equal(missing.cart, "Cart: 0");

      // A renamed button still replays, and the receipt says so. Before that, a run that drifts
      // with nothing committed frees its key: the same key runs again once the page matches.
      await fetch(site.base + "/admin?button=Checkout");
      const drift = await cell(`return site.run('add_steps', { qty: 4 }, { key: 'r1' });`);
      assert.match(drift.out.error, /ABILITY_DRIFT: no button "Add to cart"/);
      assert.doesNotMatch(drift.out.error, /CHROME_ERROR/);
      await fetch(site.base + "/admin?button=" + encodeURIComponent("Add to basket"));
      const retry = await cell(`return site.run('add_steps', { qty: 4 }, { key: 'r1' });`);
      assert.equal(retry.cart, "Cart: 4", JSON.stringify(retry));
      assert.deepEqual(retry.out.adapted, [
        {
          from: { role: "button", name: "Add to cart" },
          to: { role: "button", name: "Add to basket" },
        },
      ]);

      // The CLI: list with no site shows the ability, and a steps run replays in a site tab.
      const listed = await run(process.execPath, [stack.cli, "abilities", "list", "--json"], {
        env: stack.env,
      });
      assert.ok(
        JSON.parse(listed.stdout).some((item) => item.name === "add_steps"),
        listed.stdout,
      );
      const fromCli = await run(
        process.execPath,
        [stack.cli, "abilities", "run", site.host, "add_steps", "--inputs", '{"qty":5}', "--json"],
        { env: stack.env },
      );
      assert.equal(JSON.parse(fromCli.stdout).write.write_status, "applied", fromCli.stdout);

      // The daemon's construction: the shared host builder over a bridge of its own.
      const previous = process.env.SITE_TO_API_HOME;
      process.env.SITE_TO_API_HOME = stack.env.SITE_TO_API_HOME;
      try {
        const { abilityHostFor, runAbility } =
          await import("../packages/site-mapper/dist/index.js");
        const bridge = {
          run: async (code) => {
            const out = await stack.repl(`console.log('RESULT ' + JSON.stringify(await ${code}));`);
            const value = /^RESULT (.*)$/m.exec(out.stdout);
            assert.ok(value, out.stdout + out.stderr);
            return JSON.parse(value[1]);
          },
          status: async () => ({ browsers: 1 }),
          close: () => undefined,
        };
        const host = abilityHostFor(site.host, { bridge, session: "daemon-like" });
        const done = await runAbility(site.host, "add_script", { qty: 6 }, { host, key: "d1" });
        assert.equal(done.result.cart, "Cart: 6", JSON.stringify(done));
      } finally {
        if (previous === undefined) delete process.env.SITE_TO_API_HOME;
        else process.env.SITE_TO_API_HOME = previous;
      }
    } finally {
      await stack.stop();
      site.server.close();
    }
  },
);
