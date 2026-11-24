// browser_code realms run in the local Aeon process (a vm context in a worker thread), reached
// over the extension's socket. They keep the sandbox page's semantics and see nothing of Node.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRealmServer } from "../dist/code-realm-server.js";

function harness(answer = (request) => ({ value: { echo: request } })) {
  const server = new BrowserRealmServer();
  const waits = new Map();
  const calls = [];
  const socket = {
    readyState: 1,
    send(text) {
      const frame = JSON.parse(text);
      setImmediate(() => {
        if (frame.kind === "browser.realm.op.reply") return waits.get(frame.opId)?.(frame);
        const event = frame.event;
        if (event.kind === "call") calls.push(event.request);
        const value = event.kind === "call" ? answer(event.request) : { ok: true };
        if (value === undefined) return; // a call the browser never answers
        server.handle({ kind: "browser.realm.event.reply", eventId: frame.eventId, value }, socket);
      });
    },
  };
  let sequence = 0;
  const op = (body) =>
    new Promise((resolve) => {
      const opId = String(++sequence);
      waits.set(opId, resolve);
      server.handle({ kind: "browser.realm.op", opId, op: body }, socket);
    });
  const cell = async (chatId, code, extra = {}) =>
    (await op({ kind: "cell", cellId: `c${++sequence}`, chatId, code, ...extra })).value;
  return { server, op, cell, calls };
}

test("a realm has the Web platform and no Node globals", async () => {
  const { server, cell } = harness();
  const probe = await cell(
    "a",
    `[typeof process, typeof require, typeof module, typeof Buffer, typeof setTimeout,
      typeof URL, typeof URLSearchParams, typeof atob, typeof btoa, typeof TextEncoder,
      typeof TextDecoder, typeof structuredClone, typeof crypto.randomUUID, typeof Headers]`,
  );
  assert.deepEqual(probe.value, [
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "function",
    "function",
    "function",
    "function",
    "function",
    "function",
    "function",
    "function",
    "function",
    "function",
  ]);
  await server.close();
});

test("no host constructor builds code that reaches the process", async () => {
  const { server, cell } = harness();
  const escapes = await cell(
    "a",
    `[() => URL.constructor('return process')(),
      () => crypto.constructor.constructor('return process')(),
      () => new TextEncoder().encode('x').constructor.constructor('return process')(),
      () => (function () {}).constructor('return typeof process')()]
      .map((f) => { try { return String(f()); } catch (error) { return 'blocked'; } })`,
  );
  assert.deepEqual(escapes.value, ["blocked", "blocked", "blocked", "blocked"]);
  await server.close();
});

test("REPL state, calls, errors and async rejections keep the sandbox's shapes", async () => {
  const { server, cell, calls } = harness();
  assert.equal((await cell("a", "const kept = 41; kept")).value, 41);
  const printed = await cell("a", "console.log('n', kept + 1); await __call({hello: 1})");
  assert.equal(printed.output, "n 42\n");
  assert.deepEqual(printed.value, { echo: { hello: 1 } });
  assert.deepEqual(calls.at(-1), { hello: 1 });
  const failed = await cell("a", "throw new Error('boom')");
  assert.match(failed.error, /^CODE_ERROR: boom\nHint: /);
  const late = await cell("a", "Promise.reject(new Error('late')); 1");
  assert.equal(late.error, "late");
  const other = await cell("b", "typeof kept");
  assert.equal(other.value, "undefined", "each chat has its own realm");
  await server.close();
});

test("an interrupt fails the waiting call and returns the partial value", async () => {
  const { server, op } = harness(() => undefined);
  const running = op({
    kind: "cell",
    cellId: "slow",
    chatId: "a",
    code: "globalThis.rows = [1, 2, 3]; await __call({never: true})",
  });
  await new Promise((done) => setTimeout(done, 200));
  await op({ kind: "interrupt", chatId: "a", cellId: "slow" });
  const reply = (await running).value;
  assert.deepEqual(reply.value, [1, 2, 3]);
  assert.match(reply.error, /TIMEOUT: browser cell did not finish; partial value returned/);
  await server.close();
});

test("a blocked realm thread is replaced by restart, and new cells work", async () => {
  const { server, op, cell } = harness();
  const stuck = op({ kind: "cell", cellId: "loop", chatId: "z", code: "await 0; while (true) {}" });
  await new Promise((done) => setTimeout(done, 200));
  const reset = await Promise.race([
    op({ kind: "reset", chatId: "z" }),
    new Promise((done) => setTimeout(done, 500, "no answer")),
  ]);
  assert.equal(reset, "no answer");
  assert.equal((await op({ kind: "restart" })).value, true);
  assert.match((await stuck).error, /^INTERNAL: .*runtime reset/);
  assert.equal((await cell("z", "2 + 2")).value, 4);
  await server.close();
});

test("a synchronous cell is bounded by its deadline", async () => {
  const { server, cell } = harness();
  const reply = await cell("a", "while (true) {}", { timeoutMs: 300 });
  assert.match(reply.error, /timed out/);
  assert.equal((await cell("a", "'alive'")).value, "alive");
  await server.close();
});
