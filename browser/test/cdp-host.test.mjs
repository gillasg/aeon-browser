// A page that rebinds the endpoint's name, or calls it from another origin, must not drive it.
// Playwright's connectOverCDP sends Host: 127.0.0.1:<port> and no Origin; that path stays open.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { CdpServer } from "../packages/cdp/dist/server.js";

test("a web page cannot drive CDP through a rebound host or a foreign origin", async () => {
  let opened = 0;
  const token = "attacker-token";
  const server = new CdpServer(token, {
    openTab: async () => {
      opened += 1;
      return { tabId: opened, targetId: `t${opened}`, url: "about:blank", title: "x" };
    },
    closeTab: async () => undefined,
    listTabs: async () => [],
    command: async () => ({}),
  });
  const port = await server.start(0);
  try {
    const plain = await fetch(`http://127.0.0.1:${port}/json/version?token=${token}`);
    assert.equal(plain.status, 200);

    const rebound = await raw(
      port,
      `GET /json/version?token=${token} HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n`,
    );
    assert.match(rebound, /^HTTP\/1\.1 403/);

    const cross = await raw(
      port,
      `PUT /json/new?token=${token}&url=https://evil.com HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.com\r\nConnection: close\r\n\r\n`,
    );
    assert.match(cross, /^HTTP\/1\.1 403/);
    assert.equal(opened, 0);

    const upgrade = await raw(
      port,
      `GET /devtools/browser/x?token=${token} HTTP/1.1\r\nHost: evil.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.match(upgrade, /^HTTP\/1\.1 403/);

    const local = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/x?token=${token}`);
    await once(local, "open");
    local.close();

    const foreign = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/x?token=${token}`, {
      origin: "http://evil.com",
    });
    await assert.rejects(() => once(foreign, "open"));

    const loopback = await raw(
      port,
      `GET /json/version?token=${token} HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(loopback, /^HTTP\/1\.1 200/);
    const v6 = await raw(
      port,
      `GET /json/version?token=${token} HTTP/1.1\r\nHost: [::1]:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(v6, /^HTTP\/1\.1 200/);
    assert.equal(opened, 0);
  } finally {
    await server.stop();
  }
});

function raw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(data);
    };
    socket.setTimeout(2000, finish);
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) finish();
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (data) resolve(data);
      else reject(error);
    });
    socket.on("connect", () => socket.write(request));
  });
}

function once(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`WebSocket refused (${response.statusCode})`));
    });
  });
}
