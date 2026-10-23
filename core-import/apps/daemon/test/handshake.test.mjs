import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startDevHandshakeServer } from "../dist/dev-harness.js";

const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

function openClient(url, origin = extensionOrigin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readMessage(socket) {
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

async function withHarness(run) {
  const harness = await startDevHandshakeServer({
    port: 0,
    grant: "A".repeat(43),
    printGrant: false,
  });
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

test("daemon accepts typed UI and extension-executor hellos then rejects privileged commands", async () => {
  await withHarness(async ({ url, grant }) => {
    const ui = await openClient(url);
    ui.send(
      JSON.stringify({
        kind: "hello",
        protocolVersion: { major: 1, minor: 1 },
        role: "ui",
        connectionGrant: grant,
      }),
    );
    assert.equal((await readMessage(ui)).role, "ui");

    const executor = await openClient(url);
    executor.send(
      JSON.stringify({
        kind: "hello",
        protocolVersion: { major: 1, minor: 1 },
        role: "extension-executor",
        connectionGrant: grant,
      }),
    );
    assert.equal((await readMessage(executor)).role, "extension-executor");
    executor.send(JSON.stringify({ kind: "command", operation: "browser.open" }));
    const rejection = await readMessage(executor);
    assert.equal(rejection.kind, "hello.reject");
    assert.equal(rejection.code, "PRIVILEGED_COMMANDS_DISABLED");
    ui.close();
    executor.close();
  });
});

test("missing and incompatible protocol majors produce typed rejection", async () => {
  await withHarness(async ({ url, grant }) => {
    for (const [hello, expectedCode] of [
      [{ kind: "hello", role: "ui", connectionGrant: grant }, "PROTOCOL_VERSION_REQUIRED"],
      [
        {
          kind: "hello",
          protocolVersion: { major: 2, minor: 0 },
          role: "ui",
          connectionGrant: grant,
        },
        "UNSUPPORTED_PROTOCOL_MAJOR",
      ],
    ]) {
      const client = await openClient(url);
      client.send(JSON.stringify(hello));
      const response = await readMessage(client);
      assert.equal(response.kind, "hello.reject");
      assert.equal(response.code, expectedCode);
      client.terminate();
    }
  });
});

test("daemon rejects bad grants, reserved desktop role, and web-page origins", async () => {
  await withHarness(async ({ url, grant }) => {
    const invalidGrant = await openClient(url);
    invalidGrant.send(
      JSON.stringify({
        kind: "hello",
        protocolVersion: { major: 1, minor: 1 },
        role: "ui",
        connectionGrant: "B".repeat(43),
      }),
    );
    assert.equal((await readMessage(invalidGrant)).code, "AUTHENTICATION_FAILED");
    invalidGrant.terminate();

    const desktop = await openClient(url);
    desktop.send(
      JSON.stringify({
        kind: "hello",
        protocolVersion: { major: 1, minor: 1 },
        role: "desktop-ui",
        connectionGrant: grant,
      }),
    );
    assert.equal((await readMessage(desktop)).code, "ROLE_NOT_AVAILABLE");
    desktop.terminate();

    const webPage = new WebSocket(url, { origin: "http://127.0.0.1" });
    const response = await readMessage(webPage);
    assert.equal(response.code, "ORIGIN_NOT_ALLOWED");
    webPage.terminate();
  });
});

test("malformed and open-ended hello objects are rejected", async () => {
  await withHarness(async ({ url, grant }) => {
    for (const hello of [
      { kind: "other" },
      {
        kind: "hello",
        protocolVersion: { major: 1, minor: 1 },
        role: "ui",
        connectionGrant: grant,
        unexpected: true,
      },
    ]) {
      const client = await openClient(url);
      client.send(JSON.stringify(hello));
      const response = await readMessage(client);
      assert.equal(response.kind, "hello.reject");
      assert.ok(["MALFORMED_HELLO", "INVALID_HELLO"].includes(response.code));
      client.terminate();
    }
  });
});
