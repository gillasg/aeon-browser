import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";
import { openChatStore } from "@aeon/store";
import { startCoreTransport } from "../dist/core-transport.js";
import { startNativeTransport } from "../dist/native-transport.js";
import { acquireCoreLock } from "../dist/core-startup.js";
import { CoreAttention } from "../dist/core-attention.js";
import { ChatService } from "../dist/chat-service.js";
import { BrowserControlService } from "../dist/browser-control-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";
import { connectCore, command, until } from "./core-client-helper.mjs";

test("two native clients share Pi, steer without waiting, and reconnect to the same chat", async () => {
  const fixture = await createFixture();
  try {
    const orb = await connectCore(fixture.directory, "orb");
    const desktop = await connectCore(fixture.directory, "desktop");
    const created = await command(orb, "chat.create", { title: "Shared session" });
    const chatId = created.result.chat.chatId;
    for (const client of [orb, desktop]) {
      client.socket.send(
        JSON.stringify({ kind: "chat.subscribe", requestId: randomUUID(), chatId }),
      );
      await until(() => client.history.some((message) => message.kind === "chat.snapshot"));
    }
    let finish;
    fixture.pi.waitForSubmit = new Promise((resolve) => {
      finish = resolve;
    });
    await command(orb, "chat.submit", { chatId, text: "First message" });
    await until(() => fixture.pi.prompts.length === 1);
    await command(desktop, "chat.queue", { chatId, text: "Steer from desktop", mode: "steer" });
    const controls = await command(orb, "chat.controls", { chatId });
    assert.deepEqual(controls.result.controls.steeringQueue, ["Steer from desktop"]);
    assert.equal(fixture.pi.creations, 1);
    await command(desktop, "chat.stop", { chatId });
    desktop.socket.terminate();
    const reconnected = await connectCore(fixture.directory, "desktop");
    const listed = await command(reconnected, "chat.list", { limit: 20 });
    assert.ok(listed.result.chats.some((chat) => chat.chatId === chatId));
    assert.equal(fixture.pi.creations, 1);
    fixture.pi.waitForSubmit = undefined;
    finish();
    await until(() => orb.history.some((message) => message.kind === "command.settled"));
    orb.socket.terminate();
    reconnected.socket.terminate();
  } finally {
    await fixture.close();
  }
});
test("Core rejects web origins, wrong tokens, executor messages and duplicate runtime ownership", async () => {
  const fixture = await createFixture();
  try {
    const discovery = JSON.parse(
      await readFile(join(fixture.directory, "core-connection.json"), "utf8"),
    );
    const web = new WebSocket(discovery.endpoint, { origin: "https://example.com" });
    await assert.rejects(once(web, "open"), /403/);
    const bad = new WebSocket(discovery.endpoint);
    await once(bad, "open");
    const closed = once(bad, "close");
    bad.send(
      JSON.stringify({
        kind: "core.hello",
        protocolVersion: discovery.protocolVersion,
        surface: "desktop",
        clientId: randomUUID(),
        token: "a".repeat(43),
      }),
    );
    assert.equal((await closed)[0], 1008);
    const client = await connectCore(fixture.directory);
    const rejected = once(client.socket, "close");
    client.socket.send(JSON.stringify({ kind: "browser.inventory.full" }));
    assert.equal((await rejected)[0], 1008);
    const unlock = await acquireCoreLock(fixture.directory);
    await assert.rejects(acquireCoreLock(fixture.directory), /EADDRINUSE/);
    await unlock();
    const again = await acquireCoreLock(fixture.directory);
    await again();
  } finally {
    await fixture.close();
  }
});
test("Chrome UI and a native surface observe the same ongoing Pi chat", async () => {
  const fixture = await createFixture(true);
  try {
    const orb = await connectCore(fixture.directory, "orb");
    const { result } = await command(orb, "chat.create", { title: "Cross surface" });
    const chatId = result.chat.chatId;
    const { chrome, executor } = await chromeClients(fixture, chatId);
    chrome.socket.send(JSON.stringify({ kind: "chat.subscribe", requestId: randomUUID(), chatId }));
    await until(() => chrome.history.some((item) => item.kind === "chat.snapshot"));
    let finish;
    fixture.pi.waitForSubmit = new Promise((resolve) => {
      finish = resolve;
    });
    await command(orb, "chat.submit", { chatId, text: "Native surface prompt" });
    await until(() =>
      chrome.history.some(
        (item) =>
          item.kind === "chat.event" &&
          item.event.event.kind === "run-state" &&
          item.event.event.state === "running-unconfirmed",
      ),
    );
    await command(chrome, "chat.queue", { chatId, text: "Chrome steering", mode: "steer" });
    assert.deepEqual(
      (await command(orb, "chat.controls", { chatId })).result.controls.steeringQueue,
      ["Chrome steering"],
    );
    assert.equal(fixture.pi.creations, 1);
    await command(chrome, "chat.stop", { chatId });
    fixture.pi.waitForSubmit = undefined;
    finish();
    await until(() => orb.history.some((item) => item.kind === "command.settled"));
    for (const client of [orb, chrome, executor]) client.socket.terminate();
  } finally {
    await fixture.close();
  }
});
async function chromeClients(fixture, chatId) {
  const origin = "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh";
  const identity = { clientInstanceId: randomUUID(), browserRunId: randomUUID() };
  const bootstrap = fixture.native.handleBootstrapEnvelope({
    kind: "supervisor.bootstrap",
    origin,
    requestBase64: Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        ...identity,
      }),
    ).toString("base64"),
  });
  assert.equal(bootstrap.ok, true);
  const executor = await nativeClient(bootstrap.endpoint, origin, {
    role: "extension-executor",
    ...identity,
    connectionGrant: bootstrap.connectionGrant,
  });
  const requestId = randomUUID(),
    pageInstanceId = randomUUID();
  executor.socket.send(
    JSON.stringify({
      kind: "grant.page.issue",
      requestId,
      pageInstanceId,
      scope: { kind: "chat", chatId },
    }),
  );
  await until(() => executor.history.some((item) => item.requestId === requestId));
  const grant = executor.history.find((item) => item.requestId === requestId);
  assert.equal(grant.ok, true);
  const chrome = await nativeClient(grant.endpoint, origin, {
    role: "ui",
    ...identity,
    pageInstanceId,
    connectionGrant: grant.connectionGrant,
  });
  return { chrome, executor };
}
async function nativeClient(endpoint, origin, hello) {
  const socket = new WebSocket(endpoint, { origin }),
    history = [];
  socket.on("message", (data) => history.push(JSON.parse(String(data))));
  await once(socket, "open");
  socket.send(
    JSON.stringify({ kind: "auth.hello", protocolVersion: SUPPORTED_PROTOCOL_VERSION, ...hello }),
  );
  await until(() => history.some((item) => item.kind === "auth.ready"));
  return { socket, history };
}

async function createFixture(withEvents = false) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-core-test-"));
  const store = openChatStore(directory),
    pi = withEvents ? new EventPiPort() : new FakePiPort();
  const service = new ChatService({ dataDirectory: directory, store, pi });
  const browser = new BrowserControlService(),
    attention = new CoreAttention(directory, service);
  const transport = await startCoreTransport(directory, service, browser, undefined, attention);
  const native = await startNativeTransport(
    service,
    "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh",
    browser,
    undefined,
    attention,
  );
  return {
    directory,
    service,
    pi,
    native,
    close: async () => {
      await transport.close();
      await native.close();
      await attention.close();
      service.projects.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class EventPiPort extends FakePiPort {
  async openOrCreate(input) {
    const handle = await super.openOrCreate(input);
    if (handle.hasEvents) return handle;
    handle.hasEvents = true;
    const listeners = new Set(),
      submit = handle.submit;
    handle.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    handle.submit = async (message) => {
      for (const listener of listeners)
        listener({ kind: "run-state", state: "running-unconfirmed" });
      await submit(message);
      for (const listener of listeners) listener({ kind: "run-state", state: "idle" });
    };
    return handle;
  }
}
