import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { build } from "esbuild";

async function load(source, directory) {
  const outfile = join(directory, source + ".mjs");
  await build({
    // Aeon's own modules live in src; browser modules come from the engine package.
    entryPoints: [
      [
        new URL("../src/" + source + ".ts", import.meta.url),
        new URL("../node_modules/@browserkit/engine/src/" + source + ".ts", import.meta.url),
      ]
        .map((url) => url.pathname.replace(/^\/(\w:)/, "$1"))
        .find((path) => existsSync(path)),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    define: { __AEON_NATIVE_TRANSPORT__: "true" },
  });
  return import(pathToFileURL(outfile).href);
}
test("home first prompt uses one command with its project, files, and selected pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-home-submit-"));
  const previous = {
    window: globalThis.window,
    location: globalThis.location,
    sessionStorage: globalThis.sessionStorage,
  };
  const projectId = randomUUID(),
    commands = [];
  try {
    globalThis.window = { addEventListener() {} };
    globalThis.location = { search: "?projectId=" + projectId };
    globalThis.sessionStorage = { getItem: () => null };
    const { startHomePrompt } = await load("home-first-submit", directory);
    const chatId = randomUUID();
    const client = {
      send: (command) => {
        commands.push(command);
        return 0;
      },
      waitFor: async (predicate) => {
        const response = {
          kind: "command.completed",
          requestId: commands[0].requestId,
          operation: "chat.create",
          result: { kind: "chat.created", chat: { chatId } },
        };
        assert.equal(predicate(response), true);
        return response;
      },
    };
    const prompt = {
      text: "hello",
      model: { provider: "fixture", id: "one" },
      thinkingLevel: "low",
      attachments: [],
    };
    assert.equal(await startHomePrompt(client, prompt), chatId);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].operation, "chat.create");
    assert.deepEqual(commands[0].payload, {
      projectId,
      initialSubmit: { ...prompt, typedByUser: true, browserContexts: [] },
    });
  } finally {
    Object.assign(globalThis, previous);
    await rm(directory, { recursive: true, force: true });
  }
});
test("extension prepares on worker load and on Chrome startup or activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-native-startup-"));
  const previous = globalThis.chrome;
  const listeners = {},
    event = (name) => ({
      addListener: (listener) => {
        listeners[name] = listener;
      },
    });
  try {
    globalThis.chrome = {
      runtime: { onStartup: event("startup"), onInstalled: event("installed") },
      tabs: { onActivated: event("activated") },
      windows: { onFocusChanged: event("focus"), WINDOW_ID_NONE: -1 },
    };
    const { installNativeStartup } = await load("native-executor-lifecycle", directory);
    let calls = 0,
      retries = 0;
    installNativeStartup(
      async () => {
        calls++;
      },
      () => {
        retries++;
      },
    );
    assert.equal(calls, 1);
    listeners.startup();
    listeners.activated();
    listeners.focus(1);
    listeners.focus(-1);
    assert.equal(calls, 4);
    assert.equal(retries, 0);
  } finally {
    globalThis.chrome = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
