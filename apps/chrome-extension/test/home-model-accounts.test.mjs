import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";
import { TextDecoder } from "node:util";

async function loadModule() {
  const directory = await mkdtemp(join(tmpdir(), "aeon-model-accounts-"));
  const outfile = join(directory, "accounts.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/home-model-accounts.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  return { module: await import(pathToFileURL(outfile).href), directory };
}

/** A stand-in for core's sign-in service: state, one sign-in that asks for a key, live events. */
function fakeService(token) {
  const streams = new Set();
  let connected = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const given = request.headers["x-aeon-login-token"] ?? url.searchParams.get("token");
    response.setHeader("access-control-allow-origin", "*");
    if (given !== token) return void response.writeHead(401).end("{}");
    const json = (body) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/api/state")
      return json({
        providers: [
          {
            id: "opencode-go",
            name: "OpenCode Go",
            methods: [{ type: "api_key", label: "OpenCode Go API key", subscription: false }],
            connected,
            ...(connected ? { connection: { type: "api_key", stored: true } } : {}),
          },
        ],
        models: [],
      });
    if (url.pathname === "/api/logins") return json({ id: "login-1" });
    if (url.pathname.endsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      streams.add(response);
      if (url.pathname === "/api/logins/login-1/events")
        response.write(
          `event: login\ndata: ${JSON.stringify({ seq: 1, type: "auth_url", url: "https://example.com/sign-in" })}\n\n` +
            `event: login\ndata: ${JSON.stringify({ seq: 2, type: "prompt", promptId: "p1", kind: "secret", message: "Paste your key" })}\n\n`,
        );
      return;
    }
    if (url.pathname === "/api/logins/login-1/answer") {
      connected = true;
      for (const stream of streams)
        stream.write(
          `event: login\ndata: ${JSON.stringify({ seq: 3, type: "prompt_closed", promptId: "p1" })}\n\n` +
            `event: login\ndata: ${JSON.stringify({ seq: 4, type: "done", credentialType: "api_key" })}\n\n`,
        );
      return json({ ok: true });
    }
    response.writeHead(404).end("{}");
  });
  return {
    server,
    close: () => {
      for (const stream of streams) stream.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Node has no EventSource by default; this reads the same text/event-stream format. */
class TestEventSource {
  constructor(url) {
    this.listeners = new Map();
    this.controller = new globalThis.AbortController();
    this.onerror = null;
    void this.read(url).catch(() => this.onerror?.());
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.controller.abort();
  }
  async read(url) {
    const response = await fetch(url, { signal: this.controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        for (const listener of this.listeners.get(type) ?? []) listener({ data });
      }
    }
  }
}

const until = async (check) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), "condition not reached");
};

test("sign-in events fold into the page's steps", async () => {
  const { module, directory } = await loadModule();
  try {
    const provider = { id: "x", name: "X", methods: [], connected: false };
    let flow = { provider, method: "oauth", notes: [] };
    flow = module.applyLoginEvent(flow, { type: "info", message: "Hello", links: [{ url: "u" }] });
    flow = module.applyLoginEvent(flow, {
      type: "device_code",
      userCode: "AB-CD",
      verificationUri: "v",
    });
    flow = module.applyLoginEvent(flow, {
      type: "prompt",
      promptId: "p",
      kind: "text",
      message: "Q",
    });
    assert.equal(flow.prompt.promptId, "p");
    flow = module.applyLoginEvent(flow, { type: "prompt_closed", promptId: "other" });
    assert.ok(flow.prompt, "a different prompt closing leaves this one");
    flow = module.applyLoginEvent(flow, { type: "error", message: "Bad key" });
    assert.deepEqual(flow.result, { kind: "error", message: "Bad key" });
    assert.equal(flow.prompt, undefined);
    assert.deepEqual(flow.notes, [{ message: "Hello", links: [{ url: "u" }] }]);
    assert.deepEqual(flow.deviceCode, { userCode: "AB-CD", verificationUri: "v" });
    assert.deepEqual(module.endpointFrom("http://127.0.0.1:5000/#token=abc"), {
      origin: "http://127.0.0.1:5000",
      token: "abc",
    });
    assert.throws(() => module.endpointFrom("http://127.0.0.1:5000/"), /no token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Models page signs in through core's service and opens the provider's page as a tab", async () => {
  const { module, directory } = await loadModule();
  const service = fakeService("secret");
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const port = service.server.address().port;
  const opened = [];
  const oldChrome = globalThis.chrome;
  const oldEventSource = globalThis.EventSource;
  globalThis.EventSource = TestEventSource;
  globalThis.chrome = { tabs: { create: async ({ url }) => opened.push(url) } };
  let commands = 0;
  let modelsChanged = 0;
  const accounts = new module.HomeModelAccounts(
    async (request) => {
      commands++;
      assert.equal(request.operation, "chat.model-login");
      return {
        kind: "command.completed",
        result: { kind: "chat.model-login", url: `http://127.0.0.1:${port}/#token=secret` },
      };
    },
    () => {},
    () => modelsChanged++,
  );
  try {
    const view = () => accounts.viewProps();
    view().onShow();
    await until(() => view().state?.providers.length === 1);
    assert.equal(view().state.providers[0].connected, false);
    view().onStart(view().state.providers[0], "api_key");
    await until(() => view().flow?.prompt?.promptId === "p1");
    assert.deepEqual(opened, ["https://example.com/sign-in"]);
    view().onAnswer("p1", "sk-test");
    await until(() => view().flow?.result?.kind === "done");
    assert.equal(view().flow.prompt, undefined);
    assert.ok(modelsChanged >= 1, "the model pickers are told to reload");
    view().onCloseFlow();
    await until(() => view().state?.providers[0].connected === true);
    assert.equal(commands, 1, "one address from core serves every request");
    view().onHide();
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.EventSource = oldEventSource;
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
