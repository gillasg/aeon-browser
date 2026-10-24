// The messages the Aeon CLI uses: browser code, the default model, and the blocked-sites list.
// A fake extension executor answers them, so the daemon's side is checked without Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";
import { openChatStore } from "@aeon/store";
import { startCoreTransport } from "../dist/core-transport.js";
import { startNativeTransport } from "../dist/native-transport.js";
import { CoreAttention } from "../dist/core-attention.js";
import { ChatService } from "../dist/chat-service.js";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";
import { connectCore, until } from "./core-client-helper.mjs";

const ORIGIN = "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh";

test("browser code, the model and the blocked-sites list answer over Core", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-core-cli-"));
  const previousHome = process.env.BROWSERKIT_HOME;
  process.env.BROWSERKIT_HOME = join(directory, "browserkit");
  const store = openChatStore(directory);
  const pi = new FakePiPort();
  pi.completeTools = async () => ({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
  });
  const service = new ChatService({ dataDirectory: directory, store, pi });
  const browser = new BrowserControlService();
  const attention = new CoreAttention(directory, service);
  const transport = await startCoreTransport(directory, service, browser, undefined, attention);
  const native = await startNativeTransport(service, ORIGIN, browser, undefined, attention);
  try {
    const executor = await connectExecutor(native);
    const core = await connectCore(directory, "cli");

    const cell = await browserCell(executor, core);
    assert.equal(cell.value, 2);
    assert.equal(cell.code, "1 + 1");

    const blocked = await blockedSites(executor, core);
    assert.deepEqual(blocked.sites, ["bank.example"]);
    assert.equal(blocked.pushed.action, "replace");
    assert.deepEqual(blocked.pushed.sites, ["bank.example"]);

    const message = await modelReply(core);
    assert.equal(message.content[0].text, "done");

    core.socket.terminate();
    executor.socket.terminate();
  } finally {
    await transport.close();
    await native.close();
    await attention.close();
    service.projects.close();
    store.close();
    if (previousHome === undefined) delete process.env.BROWSERKIT_HOME;
    else process.env.BROWSERKIT_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

async function connectExecutor(native) {
  const identity = { clientInstanceId: randomUUID(), browserRunId: randomUUID() };
  const bootstrap = native.handleBootstrapEnvelope({
    kind: "supervisor.bootstrap",
    origin: ORIGIN,
    requestBase64: Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        ...identity,
      }),
    ).toString("base64"),
  });
  assert.equal(bootstrap.ok, true);
  const socket = new WebSocket(bootstrap.endpoint, { origin: ORIGIN });
  const history = [];
  socket.on("message", (data) => history.push(JSON.parse(String(data))));
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      kind: "auth.hello",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      role: "extension-executor",
      ...identity,
      connectionGrant: bootstrap.connectionGrant,
    }),
  );
  await until(() => history.some((item) => item.kind === "auth.ready"));
  socket.send(
    JSON.stringify({
      kind: "browser.inventory.full",
      ...identity,
      generation: 1,
      capabilities: ["browser-code-v1"],
      windows: [],
      tabs: [],
    }),
  );
  await until(() => history.some((item) => item.kind === "browser.inventory.applied"));
  return { socket, history };
}

async function browserCell(executor, core) {
  const requestId = randomUUID();
  core.socket.send(
    JSON.stringify({
      kind: "core.browser.run",
      requestId,
      code: "1 + 1",
      session: "cli",
      timeoutMs: 10_000,
    }),
  );
  await until(() => executor.history.some((item) => item.kind === "browser.code.run"));
  const run = executor.history.find((item) => item.kind === "browser.code.run");
  executor.socket.send(
    JSON.stringify({
      kind: "browser.code.result",
      cellId: run.cellId,
      output: "",
      value: 2,
      steps: [],
      opened: [],
    }),
  );
  await until(() =>
    core.history.some(
      (item) => item.requestId === requestId && item.kind === "core.browser.result",
    ),
  );
  return { ...core.history.find((item) => item.requestId === requestId), code: run.code };
}

async function blockedSites(executor, core) {
  const requestId = randomUUID();
  core.socket.send(
    JSON.stringify({
      kind: "core.blocked-sites",
      requestId,
      action: "add",
      site: "bank.example",
    }),
  );
  await until(() => executor.history.some((item) => item.kind === "native.blocked-sites"));
  const pushed = executor.history.find((item) => item.kind === "native.blocked-sites");
  await until(() => core.history.some((item) => item.requestId === requestId));
  return { ...core.history.find((item) => item.requestId === requestId), pushed };
}

async function modelReply(core) {
  const requestId = randomUUID();
  core.socket.send(
    JSON.stringify({
      kind: "core.model.complete",
      requestId,
      systemPrompt: "Name things.",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "set_names", parameters: { type: "object" } }],
    }),
  );
  await until(() => core.history.some((item) => item.requestId === requestId));
  return core.history.find((item) => item.requestId === requestId).message;
}
