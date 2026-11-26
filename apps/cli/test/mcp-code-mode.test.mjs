// The five-tool code surface: its footprint gate, parking a cell on a hand-off and resuming it,
// per-client tokens, and the Streamable HTTP guard.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
/* global AbortController */
import { fileURLToPath } from "node:url";
import {
  CODE_SURFACE_TOOLS,
  ParkingLot,
  pausedLine,
  pendingHandoff,
  pollHandoff,
  runParkableCell,
} from "../dist/mcp-code-mode.js";
import {
  createToken,
  readTokens,
  requestToken,
  revokeToken,
  verifyToken,
} from "../dist/mcp-tokens.js";
import { serveMcpHttp } from "../dist/mcp-http.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FIVE = ["browser_code", "aeon_find", "aeon_call", "aeon_resume", "aeon_run"];
const BUDGET = 3.5 * 1024;

function listTools(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "mcp", ...args], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        AEON_DATA_DIR: join(tmpdir(), "aeon-code-mcp-" + process.pid),
        SITE_TO_API_HOME: join(tmpdir(), "aeon-code-mcp-sites-" + process.pid),
      },
    });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      child.kill();
      resolve(JSON.parse(buffer.slice(0, index)).result.tools);
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  });
}

test("default tools/list is exactly the five code tools, within 3.5 KB", async () => {
  const tools = await listTools([]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    FIVE,
  );
  const bytes = Buffer.byteLength(JSON.stringify(tools));
  assert.ok(bytes <= BUDGET, `tools/list is ${bytes} bytes, over ${BUDGET}`);
  assert.ok(Buffer.byteLength(JSON.stringify(CODE_SURFACE_TOOLS)) <= BUDGET);
});

test("--surface full keeps the expanded list", async () => {
  const names = (await listTools(["--surface", "full"])).map((tool) => tool.name);
  assert.ok(names.includes("aeon_run_status"));
  assert.ok(names.includes("catalog_search"));
  assert.ok(names.length > FIVE.length);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("a cell blocked on a hand-off returns Paused; aeon_resume returns its value", async () => {
  const lot = new ParkingLot();
  const cell = deferred();
  const result = await runParkableCell(lot, {
    run: () => cell.promise,
    watchHandoff: async () => ({
      why: "Touch ID for checkout",
      kind: "auth",
      tab: "t7",
      title: "Pay",
    }),
  });
  const [first, ...rest] = result.content[0].text.split("\n");
  assert.equal(first, "paused · waiting for you in Chrome: Touch ID for checkout");
  const paused = JSON.parse(rest.join("\n"));
  assert.equal(paused.status, "paused");
  assert.match(paused.handle, /^h_[0-9a-f]{32}$/);
  assert.deepEqual(paused.where, { tab: "t7", title: "Pay" });
  assert.equal(result.isError, false);
  // Still waiting: the same Paused comes back.
  const again = await lot.resume(paused.handle, 20);
  assert.equal(again.structuredContent.handle, paused.handle);
  cell.resolve({ content: [{ type: "text", text: "200 rows" }], isError: false });
  const done = await lot.resume(paused.handle, 1000);
  assert.equal(done.content[0].text, "200 rows");
  const gone = await lot.resume(paused.handle, 0);
  assert.equal(gone.isError, true);
});

test("a cell that finishes first never parks", async () => {
  const lot = new ParkingLot();
  const result = await runParkableCell(lot, {
    run: async () => ({ content: [{ type: "text", text: "ok" }] }),
    watchHandoff: (signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined))),
  });
  assert.equal(result.content[0].text, "ok");
});

test("a task-augmented cell goes input_required while parked and back to working", async () => {
  const lot = new ParkingLot();
  const cell = deferred();
  const cleared = deferred();
  const seen = [];
  let watched = 0;
  const running = runParkableCell(
    lot,
    {
      run: () => cell.promise,
      watchHandoff: async (signal) => {
        if (watched++ === 0) return { why: "Bank OTP" };
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
      },
      watchCleared: () => cleared.promise,
    },
    { onPause: (message) => seen.push(message), onResume: () => seen.push("resumed") },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, [pausedLine("Bank OTP")]);
  cleared.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, [pausedLine("Bank OTP"), "resumed"]);
  cell.resolve({ content: [{ type: "text", text: "done" }] });
  assert.equal((await running).content[0].text, "done");
});

test("pendingHandoff and pollHandoff read the tab listing", async () => {
  assert.equal(pendingHandoff([{ title: "x" }]), undefined);
  assert.deepEqual(
    pendingHandoff([{ target: { tabId: 3 }, title: "Bank", handoff: { message: "OTP" } }]),
    { why: "OTP", tab: "t3", title: "Bank" },
  );
  let calls = 0;
  const list = async () => (++calls < 3 ? [] : [{ handoff: { message: "Passkey" } }]);
  const found = await pollHandoff(list, new AbortController().signal, { everyMs: 1, firstMs: 1 });
  assert.equal(found.why, "Passkey");
});

test("a hand-off counts by ownership first: another client's never pauses this cell", () => {
  const theirs = { mine: false, title: "B", handoff: { message: "B login", startedAt: 5_000 } };
  const ours = { mine: true, title: "A", handoff: { message: "A login", startedAt: 100 } };
  // Client B raised a hand-off mid-cell (after `since`) on its own tab: not ours.
  assert.equal(pendingHandoff([theirs], 1_000), undefined);
  // Ours counts even if it started before `since` (e.g. a cell in this session raised it).
  assert.equal(pendingHandoff([theirs, ours], 1_000)?.why, "A login");
  // No ownership field: `since` is the fallback.
  assert.equal(pendingHandoff([{ handoff: { message: "old", startedAt: 100 } }], 1_000), undefined);
  assert.equal(
    pendingHandoff([{ handoff: { message: "new", startedAt: 2_000 } }], 1_000)?.why,
    "new",
  );
});

test("client tokens: hashed at rest in a 0600 file, verified, revoked", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aeon-tokens-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = await createToken("agent-one", dir);
  assert.match(token, /^aeon_mcp_/);
  const saved = await readTokens(dir);
  assert.equal(saved.length, 1);
  assert.ok(!JSON.stringify(saved).includes(token), "the token itself is never stored");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(dir, "mcp-tokens.json"))).mode & 0o777, 0o600);
  }
  assert.equal(await verifyToken(token, dir), "agent-one");
  assert.equal(await verifyToken(token + "x", dir), undefined);
  assert.equal(await verifyToken("nope", dir), undefined);
  assert.equal(requestToken({ authorization: `Bearer ${token}` }), token);
  assert.equal(requestToken({ "x-aeon-token": token }), token);
  assert.equal(await revokeToken("agent-one", dir), true);
  assert.equal(await verifyToken(token, dir), undefined);
});

test("Streamable HTTP: loopback Host only, token required, JSON-RPC answered", async (t) => {
  const lines = [];
  const server = await serveMcpHttp({
    port: 0,
    verify: async (token) => (token === "aeon_mcp_good" ? "tester" : undefined),
    receive: async (message, send) => {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    },
    audit: (line) => lines.push(line),
  });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const { port } = new URL(server.url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const post = (headers) =>
    rawRequest(
      port,
      { method: "POST", headers: { "content-type": "application/json", ...headers } },
      body,
    );
  assert.equal(
    (await post({ host: "evil.example:80", authorization: "Bearer aeon_mcp_good" })).status,
    403,
  );
  assert.equal(
    (await post({ origin: "https://evil.example", authorization: "Bearer aeon_mcp_good" })).status,
    403,
  );
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: "Bearer aeon_mcp_bad" })).status, 401);
  const ok = await post({ authorization: "Bearer aeon_mcp_good" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).result, { ok: true });
  assert.ok(ok.headers["mcp-session-id"]);
  assert.deepEqual(lines, ["mcp tester ping"]);
});

async function rawRequest(port, options, body) {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", ...options }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body: text }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}
