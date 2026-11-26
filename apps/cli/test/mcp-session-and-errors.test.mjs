import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveMcpHttp, sessionBindings } from "../dist/mcp-http.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = { authorization: "Bearer aeon_mcp_good" };

function post(port, session, message) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": session, ...auth },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve(text ? JSON.parse(text) : undefined));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(message));
  });
}

function openStream(port, session) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "GET",
        headers: { "mcp-session-id": session, ...auth },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          for (const line of chunk.split("\n"))
            if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
        });
        resolve({ frames, close: () => req.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("HTTP: a session's aeon/tap frames reach only that session; global ones reach all", async (t) => {
  let next = 0;
  const server = await serveMcpHttp({
    port: 0,
    audit: () => undefined,
    verify: async (token) => (token === "aeon_mcp_good" ? "tester" : undefined),
    receive: async (message, send) => {
      if (message.method === "events/subscribe")
        send({ jsonrpc: "2.0", id: message.id, result: { subscriptionId: `sub-${++next}` } });
    },
  });
  t.after(() => server.close());
  const { port } = new URL(server.url);
  const a = await openStream(port, "session-a");
  const b = await openStream(port, "session-b");
  t.after(() => (a.close(), b.close()));
  const subscribe = {
    jsonrpc: "2.0",
    id: 1,
    method: "events/subscribe",
    params: { name: "aeon/tap" },
  };
  const { result } = await post(port, "session-a", subscribe);
  const tap = (subscriptionId) => ({
    jsonrpc: "2.0",
    method: "notifications/events/emitted",
    params: { subscriptionId, name: "aeon/tap", payload: { data: "secret" } },
  });
  server.broadcast(tap(result.subscriptionId));
  server.broadcast(tap("sub-unknown"));
  server.broadcast({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const taps = (frames) => frames.filter((frame) => frame.params?.name === "aeon/tap");
  assert.equal(taps(a.frames).length, 1);
  assert.equal(taps(a.frames)[0].params.subscriptionId, result.subscriptionId);
  assert.equal(taps(b.frames).length, 0);
  for (const frames of [a.frames, b.frames])
    assert.ok(frames.some((frame) => frame.method === "notifications/tools/list_changed"));
});

test("stdio: malformed JSON gets JSON-RPC -32700 Parse error", async () => {
  const child = spawn(process.execPath, [cli, "mcp"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      AEON_DATA_DIR: join(tmpdir(), "aeon-mcp-parse-" + process.pid),
      SITE_TO_API_HOME: join(tmpdir(), "aeon-mcp-parse-sites-" + process.pid),
    },
  });
  const line = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) resolve(buffer.slice(0, index));
    });
    child.on("error", reject);
    child.stdin.write("{not json\n");
  });
  child.kill();
  const reply = JSON.parse(line);
  assert.equal(reply.id, null);
  assert.equal(reply.error.code, -32700);
  assert.equal(reply.error.message, "Parse error");
});

test("HTTP session bindings: another token is refused, and idle or closed sessions are dropped", () => {
  const streams = new Map();
  const bindings = sessionBindings(() => streams, 1_000_000);
  try {
    assert.equal(bindings.claim("s1", "alice"), true);
    assert.equal(bindings.claim("s1", "bob"), false);
    assert.equal(bindings.claim("s2", "bob"), true);
    bindings.delete("s2");
    assert.equal(bindings.size(), 1);
  } finally {
    bindings.stop();
  }
  const idle = sessionBindings(() => streams, 0);
  try {
    idle.claim("s3", "alice");
    streams.set("s4", new Set());
    idle.claim("s4", "alice");
    idle.sweep();
    // s3 expired; s4 still has an open stream.
    assert.equal(idle.size(), 1);
  } finally {
    idle.stop();
  }
});
