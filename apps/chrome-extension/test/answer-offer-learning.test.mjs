import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const stubs = {
  "@browserkit/engine/native-browser-network":
    "export const calls = globalThis.__learnCalls = [];" +
    "export async function learnUserTab(tabId, on) { calls.push(['learn', tabId, on]); }" +
    "export async function networkCall(tabId, op) { calls.push(['network', tabId, op]); return { log: { entries: [] } }; }",
  "./companion-requests.js": "export async function askCore() { return []; }",
  "./chat-composer-submit.js": "export async function submitComposerMessage() {}",
};

async function load(entry) {
  const directory = await mkdtemp(fileURLToPath(new URL("./.answer-offer-", import.meta.url)));
  const outfile = join(directory, "out.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "stubs",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            stubs[args.path] ? { path: args.path, namespace: "stub" } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stubs[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeChrome() {
  const store = new Map();
  const listeners = {};
  const event = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  globalThis.chrome = {
    runtime: {
      id: "ext",
      onMessage: event("message"),
      sendMessage: async (request) => {
        fakeChrome.sent.push(request);
        return { ok: true, removed: false };
      },
    },
    tabs: {
      onUpdated: event("updated"),
      onRemoved: event("removed"),
      get: async (tabId) => ({ id: tabId, url: "https://example.com/" }),
    },
    debugger: { onDetach: event("detach") },
    storage: {
      session: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (items) => Object.entries(items).forEach(([k, v]) => store.set(k, v)),
        remove: async (key) => store.delete(key),
      },
    },
  };
  fakeChrome.sent = [];
  return { store, listeners };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("teaching survives a sleeping service worker: detach and page loads read the session record", async () => {
  const { store, listeners } = fakeChrome();
  const learning = await load("../src/browse-learning.ts");
  learning.installBrowseLearning();
  // The worker woke up with no timers: only the session record says tab 5 is teaching.
  store.set("aeon-learn:5", { site: "example.com", baseline: [], found: 0 });
  listeners.updated(5, { status: "complete" });
  await settle();
  assert.deepEqual(globalThis.__learnCalls.at(-1), ["network", 5, "take"]);
  listeners.detach({ tabId: 5 });
  await settle();
  assert.ok(globalThis.__learnCalls.some((call) => call.join() === "learn,5,false"));
  assert.equal(store.has("aeon-learn:5"), false);
  // A tab that never taught is left alone.
  const before = globalThis.__learnCalls.length;
  listeners.detach({ tabId: 6 });
  listeners.updated(6, { status: "complete" });
  await settle();
  assert.equal(globalThis.__learnCalls.length, before);
});

test("an answer offer handled here passes the page url and shows its notice", async () => {
  fakeChrome();
  const { sendAnswerOffer, reportWrongInput } = await load("../src/answer-offer.ts");
  const notices = [];
  const errors = [];
  await sendAnswerOffer({
    client: undefined,
    chatId: "c1",
    offer: { action: "toggle-boost", label: "Turn off", followUp: "", args: { boostId: "" } },
    wasRunning: false,
    answerText: "",
    url: "https://example.com/page",
    onError: (message) => errors.push(message),
    onNotice: (message) => notices.push(message),
    pin: async () => undefined,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, ["Boost off"]);
  assert.equal(fakeChrome.sent[0].url, "https://example.com/page");
  assert.deepEqual(reportWrongInput("https://www.Example.com/x"), {
    site: "example.com",
    quirk: "The user marked this answer as wrong.",
  });
  assert.equal(reportWrongInput("chrome://newtab"), null);
  assert.equal(reportWrongInput(undefined), null);
});
