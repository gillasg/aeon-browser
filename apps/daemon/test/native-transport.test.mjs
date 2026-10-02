import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  AuthHelloSchema,
  BrowserInventoryFullSchema,
  NativeBootstrapRequestSchema,
  NativeSupervisorBootstrapEnvelopeSchema,
  PageGrantIssueRequestSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "@pippin/protocol";
import { WebSocket } from "ws";
import { startNativeTransport } from "../dist/native-transport.js";

const origin = "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh";
const clientInstanceId = "091b9308-1ee9-420e-b71f-a564a5a27701";
const browserRunId = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";
const pageInstanceId = "06ee7821-bcb2-407f-b443-f8cdfe33726d";
const chatId = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const otherChatId = "005cfe90-b334-4b04-bb8e-e50b091f2fe5";

test("native transport rejects an untrusted Origin and gates UI grants on inventory", async () => {
  const fixture = await createFixture();
  try {
    assert.equal(fixture.bootstrap.ok, true);
    assert.equal(new URL(fixture.bootstrap.endpoint).search, "");
    assert.equal(
      fixture.transport.handleBootstrapEnvelope({
        ...fixture.envelope,
        origin: "https://127.0.0.1",
      }).code,
      "ORIGIN_NOT_ALLOWED",
    );
    const wrong = new WebSocket(fixture.bootstrap.endpoint, { origin: "https://127.0.0.1" });
    await assert.rejects(once(wrong, "open"), /Unexpected server response: 403/);
    if (!fixture.bootstrap.ok) return;
    const executor = await authenticate(
      fixture.bootstrap.endpoint,
      executorHello(fixture.bootstrap.connectionGrant),
    );
    assert.equal(executor.reply.kind, "auth.ready");
    const closed = once(executor.socket, "close");
    executor.socket.send(JSON.stringify(pageRequest()));
    assert.equal((await closed)[0], 1008);
  } finally {
    await fixture.transport.close();
  }
});

test("native grant chain binds Chat scope and rejects replay or a second Chat", async () => {
  const fixture = await createFixture();
  try {
    if (!fixture.bootstrap.ok) throw new Error("Native bootstrap fixture failed.");
    const executor = await authenticate(
      fixture.bootstrap.endpoint,
      executorHello(fixture.bootstrap.connectionGrant),
    );
    const inventory = BrowserInventoryFullSchema.parse({
      kind: "browser.inventory.full",
      clientInstanceId,
      browserRunId,
      generation: 1,
      windows: [],
      tabs: [],
    });
    const applied = nextMessage(executor.socket);
    executor.socket.send(JSON.stringify(inventory));
    assert.deepEqual(await applied, {
      kind: "browser.inventory.applied",
      generation: 1,
      lastSequence: 0,
    });

    const grantWait = nextMessage(executor.socket);
    executor.socket.send(JSON.stringify(pageRequest()));
    const grant = await grantWait;
    assert.equal(grant.ok, true);
    if (!grant.ok) return;
    assert.equal(grant.scope.chatId, chatId);
    const uiHello = AuthHelloSchema.parse({
      kind: "auth.hello",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      role: "ui",
      clientInstanceId,
      browserRunId,
      pageInstanceId,
      connectionGrant: grant.connectionGrant,
    });
    const ui = await authenticate(grant.endpoint, uiHello);
    assert.equal(ui.reply.kind, "auth.ready");
    const closed = once(ui.socket, "close");
    ui.socket.send(
      JSON.stringify({ kind: "chat.subscribe", requestId: randomUUID(), chatId: otherChatId }),
    );
    assert.equal((await closed)[0], 1008);

    const replay = await authenticate(grant.endpoint, uiHello);
    assert.equal(replay.reply.code, "AUTHENTICATION_FAILED");
    executor.socket.close();
    replay.socket.close();
  } finally {
    await fixture.transport.close();
  }
});

async function createFixture() {
  const transport = await startNativeTransport(
    {
      async getChatView() {
        return {};
      },
    },
    origin,
  );
  const request = NativeBootstrapRequestSchema.parse({
    kind: "native.bootstrap",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    clientInstanceId,
    browserRunId,
  });
  const envelope = NativeSupervisorBootstrapEnvelopeSchema.parse({
    kind: "supervisor.bootstrap",
    origin,
    requestBase64: Buffer.from(JSON.stringify(request)).toString("base64"),
  });
  return { transport, envelope, bootstrap: transport.handleBootstrapEnvelope(envelope) };
}

function executorHello(connectionGrant) {
  return AuthHelloSchema.parse({
    kind: "auth.hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role: "extension-executor",
    clientInstanceId,
    browserRunId,
    connectionGrant,
  });
}

function pageRequest() {
  return PageGrantIssueRequestSchema.parse({
    kind: "grant.page.issue",
    requestId: randomUUID(),
    pageInstanceId,
    scope: { kind: "chat", chatId },
  });
}

async function authenticate(endpoint, hello) {
  const socket = new WebSocket(endpoint, { origin });
  await once(socket, "open");
  const reply = nextMessage(socket);
  socket.send(JSON.stringify(hello));
  return { socket, reply: await reply };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
