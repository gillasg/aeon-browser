// Pack code (an imported site tool, a node ability way) runs on an isolated worker. Walking from
// a bridge function, a host promise or the global object to a Function constructor must never
// reach the daemon's process, require or fs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installSitePack, runSiteTool, setSiteToolsEnabled } from "../dist/index.js";
import { runNodeScript } from "../dist/ability-node.js";

const home = await mkdtemp(join(tmpdir(), "bue-sandbox-"));
process.env.SITE_TO_API_HOME = home;
process.env.SANDBOX_SECRET = "daemon-only";
const site = "escape.example";
test.after(() => rm(home, { recursive: true, force: true }));

const ESCAPES = [
  'return siteMapper.call.constructor("return typeof process")();',
  'return this.constructor.constructor("return process")();',
  'return siteMapper.call("x").constructor.constructor("return process")();',
  'return browser.fetch.constructor("return require")();',
  'return (async () => {}).constructor("return process")();',
  'return eval("process");',
  "return typeof process + typeof require + typeof module + typeof Buffer;",
];

async function importTool(code) {
  const tool = {
    version: 1,
    name: "probe",
    params: [],
    code,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  const tools = JSON.stringify({ version: 1, tools: [tool], pageTools: [] });
  await installSitePack(
    {
      manifest: { format: "browserkit-site-pack", version: 1, site, files: ["tools.json"] },
      files: new Map([["tools.json", tools]]),
      skills: [],
      boosts: [],
    },
    site,
  );
  await setSiteToolsEnabled(site, "all", undefined, true);
}

const call = async () => ({ ok: true });

for (const code of ESCAPES) {
  test(`an imported site tool cannot escape: ${code}`, async () => {
    await importTool(code);
    const outcome = await runSiteTool(site, "probe", {}, { call }).then(
      (value) => ({ value }),
      (error) => ({ error: String(error.message) }),
    );
    if ("value" in outcome) assert.equal(outcome.value, "undefinedundefinedundefinedundefined");
    else assert.match(outcome.error, /SANDBOX|not defined|Code generation|EvalError|disallowed/i);
  });

  test(`a node ability script cannot escape: ${code}`, async () => {
    const outcome = await runNodeScript(code, {}, call, site).then(
      (value) => ({ value }),
      (error) => ({ error: String(error.message) }),
    );
    if ("value" in outcome) assert.equal(outcome.value, "undefinedundefinedundefinedundefined");
    else assert.match(outcome.error, /SANDBOX|not defined|Code generation|EvalError|disallowed/i);
  });
}

test("a script that reaches nothing of node cannot read env or files", async () => {
  await importTool(
    "try { return [typeof process, typeof require, typeof globalThis.fs].join(); }" +
      " catch (e) { return String(e.message); }",
  );
  assert.equal(await runSiteTool(site, "probe", {}, { call }), "undefined,undefined,undefined");
});

test("bridges still work: siteMapper.call and args cross as data", async () => {
  await importTool('const r = await siteMapper.call("search", { q: "x" }); return [r, args];');
  const seen = [];
  const value = await runSiteTool(
    site,
    "probe",
    {},
    {
      call: async (operation, params) => {
        seen.push({ operation, params });
        return { hits: 2 };
      },
    },
  );
  assert.deepEqual(value, [{ hits: 2 }, {}]);
  assert.deepEqual(seen, [{ operation: "search", params: { q: "x" } }]);
});

test("a stuck synchronous loop is stopped, not the daemon", async () => {
  await assert.rejects(
    () =>
      import("../dist/script-sandbox.js").then(({ runSandboxed }) =>
        runSandboxed({
          code: "while (true) {}",
          inputs: {},
          filename: "loop.js",
          bridges: {},
          timeoutMs: 200,
          timeoutMessage: "LOOP_TIMEOUT",
        }),
      ),
    /LOOP_TIMEOUT|timed out/,
  );
});

test("a node script's fetch is pinned to its own site", async () => {
  await assert.rejects(
    () => runNodeScript('return browser.fetch("https://other.example/x");', {}, call, site),
    /SITE_PINNED/,
  );
  await assert.rejects(
    () =>
      runNodeScript(
        'return browser.fetch("http://169.254.169.254/");',
        {},
        call,
        "169.254.169.254",
      ),
    /PRIVATE_NETWORK/,
  );
});
