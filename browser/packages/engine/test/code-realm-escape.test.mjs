// Every built-in a browser_code realm is handed must be a dead end: no constructor chain off it
// may build code that runs in the worker thread, where Node's process lives.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRealmServer } from "../dist/code-realm-server.js";
import { PLATFORM } from "../dist/code-realm-globals.js";

function realm() {
  const server = new BrowserRealmServer();
  const waits = new Map();
  const socket = {
    readyState: 1,
    send(text) {
      const frame = JSON.parse(text);
      setImmediate(() => {
        if (frame.kind === "browser.realm.op.reply") return waits.get(frame.opId)?.(frame);
        server.handle(
          { kind: "browser.realm.event.reply", eventId: frame.eventId, value: { ok: true } },
          socket,
        );
      });
    },
  };
  let sequence = 0;
  const cell = (code) =>
    new Promise((resolve) => {
      const opId = String(++sequence);
      waits.set(opId, (frame) => resolve(frame.value));
      server.handle(
        {
          kind: "browser.realm.op",
          opId,
          op: { kind: "cell", cellId: `c${sequence}`, chatId: "escape", code },
        },
        socket,
      );
    });
  return { server, cell };
}

// Each probe answers "safe" when the attempt threw or saw no process, else what it reached.
const probe = (expression) =>
  `(() => { try { const seen = (${expression}); return seen === undefined || seen === "undefined" ? "safe" : String(seen); } catch { return "safe"; } })()`;

test("no exposed built-in leads back to the worker's process", async () => {
  const { server, cell } = realm();
  const names = [
    ...PLATFORM,
    "crypto",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "performance",
  ];
  const attempts = [];
  for (const name of names) {
    const x = `globalThis[${JSON.stringify(name)}]`;
    attempts.push(
      [name, "constructor", probe(`${x}.constructor("return typeof process")()`)],
      [
        name,
        "prototype",
        probe(`${x}.prototype.constructor.constructor("return typeof process")()`),
      ],
      [name, "proto", probe(`Object.getPrototypeOf(${x}).constructor("return typeof process")()`)],
    );
  }
  attempts.push(
    [
      "crypto.subtle",
      "constructor",
      probe(`crypto.subtle.constructor.constructor("return typeof process")()`),
    ],
    ["eval", "string", probe(`eval("typeof process")`)],
    ["__realmEval", "constructor", probe(`__realmEval.constructor("return typeof process")()`)],
    ["__realmEval", "source", probe(`__realmEval("typeof process")`)],
    ["Function", "string", probe(`Function("return typeof process")()`)],
  );
  const answer = await cell(`[${attempts.map((item) => item[2]).join(",\n")}]`);
  assert.ok(Array.isArray(answer.value), JSON.stringify(answer));
  const escaped = attempts
    .map((item, index) => [item[0], item[1], answer.value[index]])
    .filter((item) => item[2] !== "safe");
  assert.deepEqual(escaped, []);
  await server.close();
});

test("the worker's process has no way to load built-in modules or native bindings", async () => {
  const { hardenHost } = await import("../dist/code-realm-globals.js");
  // Run in a child so this test process keeps its own process API.
  const { execFileSync } = await import("node:child_process");
  const url = new URL("../dist/code-realm-globals.js", import.meta.url).href;
  const out = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const { hardenHost } = await import(${JSON.stringify(url)}); hardenHost();
     console.log([typeof process.getBuiltinModule, typeof process.binding, typeof process.dlopen].join(","));`,
  ])
    .toString()
    .trim();
  assert.equal(typeof hardenHost, "function");
  assert.equal(out, "undefined,undefined,undefined");
});

test("agent-written script strings still compile, in the realm, at global scope", async () => {
  const { server, cell } = realm();
  const answer = await cell(
    `const fn = __realmEval("(async (x) => ({ doubled: x * 2, url: typeof URL, proc: typeof process }))");
     await fn(21)`,
  );
  assert.deepEqual(answer.value, { doubled: 42, url: "function", proc: "undefined" });
  await server.close();
});
