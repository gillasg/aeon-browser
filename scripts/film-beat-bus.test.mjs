import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { handleCoreFilm, handleFilmReply } from "../apps/daemon/dist/film-relay.js";
import { armBeats, beatSeen, readBeats } from "../apps/cli/dist/record-beats.js";

const from = (pkg) =>
  createRequire(fileURLToPath(new URL(`../apps/${pkg}/package.json`, import.meta.url)));
const { WebSocket, WebSocketServer } = from("daemon")("ws");
const { build } = from("chrome-extension")("esbuild");

/** chrome.storage.session as the worker and the orb share it. */
function sessionStore() {
  const data = {};
  const listeners = [];
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { newValue: v };
        data[k] = structuredClone(v);
      }
      for (const listener of listeners) listener(changes);
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  };
}

async function bundle(t, entries) {
  const dir = await mkdtemp(join(tmpdir(), "aeon-film-bus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = {};
  for (const [name, src] of Object.entries(entries)) {
    const outfile = join(dir, `${name}.mjs`);
    await build({
      entryPoints: [fileURLToPath(new URL(`../apps/chrome-extension/src/${src}`, import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    out[name] = await import(pathToFileURL(outfile).href);
  }
  return out;
}

const settle = () => new Promise((done) => setTimeout(done, 20));

test("record arms, reads and disarms the orb's beats through Core and the extension worker", async (t) => {
  const store = sessionStore();
  globalThis.chrome = { storage: { session: store } };
  t.after(() => delete globalThis.chrome);
  const { worker, orb } = await bundle(t, {
    worker: "native-worker-film.ts",
    orb: "orb/orb-film.ts",
  });
  orb.watchFilm();

  // Core: Chrome connects as an executor; the CLI connects as a local client.
  const server = new WebSocketServer({ port: 0 });
  t.after(() => server.close());
  const executors = [];
  server.on("connection", (socket, request) => {
    if (request.url === "/executor") {
      executors.push(socket);
      socket.on("message", (data) => handleFilmReply(JSON.parse(String(data))));
    } else
      socket.on("message", (data) =>
        handleCoreFilm(socket, JSON.parse(String(data)), () => executors),
      );
  });
  const url = `ws://127.0.0.1:${server.address().port}`;
  const chrome = new WebSocket(`${url}/executor`);
  chrome.on("message", (data) =>
    assert.ok(worker.handleFilmMessage(JSON.parse(String(data)), chrome)),
  );
  const cli = new WebSocket(`${url}/cli`);
  t.after(() => (chrome.close(), cli.close()));
  await Promise.all([chrome, cli].map((s) => new Promise((done) => s.once("open", done))));
  while (executors.length === 0) await settle();

  const bus = (action) =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const onMessage = (data) => {
        const message = JSON.parse(String(data));
        if (message.kind !== "core.film.result" || message.requestId !== requestId) return;
        cli.off("message", onMessage);
        resolve(message);
      };
      cli.on("message", onMessage);
      cli.send(JSON.stringify({ kind: "core.film", requestId, action }));
    });

  orb.filmBeat("send");
  await settle();
  assert.deepEqual(await readBeats(bus), [], "unarmed, the orb writes nothing");

  const since = Date.now();
  assert.equal(await armBeats(bus, true), true);
  await settle();
  assert.equal(orb.filmArmed(), true);
  orb.filmBeat("receipt", { text: "0.4 s" });
  await settle();
  const beats = await readBeats(bus);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].beat, "receipt");
  assert.ok(beatSeen(beats, "receipt", since));

  assert.equal(await armBeats(bus, false), true);
  await settle();
  assert.equal(orb.filmArmed(), false);
  assert.equal(store.data["aeon-film-armed"], false);
});
