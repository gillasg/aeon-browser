import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendEventLog } from "@graft/location";
import { buildSiteModel, parseCapture, saveModel } from "@browserkit/tools/site-to-api";

// A real `graft mcp` child over stdio, a fixture site, and the durable event log: no model, no
// browser, no daemon. Covers tool discovery, events with cursor resume, tasks and scrubbing.

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function har(origin) {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "graft-test", version: "1" },
      entries: [
        {
          startedDateTime: new Date().toISOString(),
          _resourceType: "xhr",
          request: {
            method: "GET",
            url: `${origin}/api/items?q=lamp`,
            headers: [{ name: "accept", value: "application/json" }],
          },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "application/json" }],
            content: { mimeType: "application/json", text: '{"items":[{"id":1,"name":"lamp"}]}' },
          },
        },
      ],
    },
  });
}

function startSite() {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ id: 1, name: "lamp" }] }));
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function mcp(home) {
  const child = spawn(process.execPath, [cli, "mcp", "--surface", "full"], {
    env: {
      ...process.env,
      GRAFT_DATA_DIR: join(home, "data"),
      SITE_TO_API_HOME: join(home, "site-to-api"),
      GRAFT_CATALOG_POLL_MS: "100000",
      GRAFT_EVENTS_POLL_MS: "50",
    },
  });
  let buffer = "";
  const waiting = new Map();
  const notes = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.id === undefined) notes.push(message);
      else waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method, params = {}) =>
    new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out ${method}`)), 15000);
      waiting.set(++id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (method, params) => {
    const message = await request(method, params);
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return message.result;
  };
  return { notes, request, call, close: () => child.kill() };
}

async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    const found = await check();
    if (found) return found;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`never saw ${what}`);
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "graft-mcp-ext-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  process.env.SITE_TO_API_HOME = join(home, "site-to-api");
  const { model } = await buildSiteModel(parseCapture(har(site.origin), "flow"), {
    site: "127.0.0.1",
  });
  await saveModel(model);
  const operation = model.operations[0];
  const dir = join(home, "site-to-api", "sites", "127.0.0.1", "abilities");
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "place-order.json"),
    JSON.stringify({
      name: "placeOrder",
      site: "127.0.0.1",
      description: "Place the lamp order",
      kind: "action",
      effect: "irreversible",
      inputs: { type: "object", properties: { q: { type: "string" } } },
      ways: [{ kind: "api", operations: [{ operation: operation.id, params: { q: "lamp" } }] }],
      options: {},
      stats: { runs: 0, failures: 0 },
      createdBy: "user",
      createdAt: now,
      updatedAt: now,
    }),
  );
  const client = mcp(home);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-06-18" });
  return { home, data: join(home, "data"), operation, client };
}

test("tool discovery and a 0-LLM compiled site tool call", async (t) => {
  const { client, operation } = await fixture(t);
  const init = await client.call("initialize", { protocolVersion: "2025-06-18" });
  assert.ok(init.capabilities.extensions["io.modelcontextprotocol/events"]);
  assert.ok(init.capabilities.extensions["io.modelcontextprotocol/tasks"]);
  const { tools } = await client.call("tools/list");
  const name = `site__127_0_0_1__${operation.id}`;
  assert.ok(tools.some((tool) => tool.name === name));
  const called = await client.call("tools/call", { name, arguments: { q: "lamp" } });
  assert.equal(called.isError, false);
  assert.equal(JSON.parse(called.content[0].text).items[0].name, "lamp");
});

test("events: subscribe, push, poll with cursor resume, and scrubbed payloads", async (t) => {
  const { client, data } = await fixture(t);
  const { events } = await client.call("events/list");
  assert.ok(events.some((event) => event.name === "graft/watcher.fired"));
  const sub = await client.call("events/subscribe", { name: "graft/routine.fired" });
  assert.equal(sub.cursor, "0");
  await appendEventLog(data, {
    kind: "watcher",
    routineId: "r1",
    site: "127.0.0.1",
    title: "Lamp price",
    value: {
      price: 30,
      otp: "551234",
      note: "Your verification code is 482913",
      header: "Bearer abcdefghijklmnop1234",
    },
    firedAt: new Date().toISOString(),
  });
  // Records are written raw here: the server scrubs on the way out whatever the daemon wrote.
  await appendEventLog(data, {
    kind: "webhook",
    routineId: "r2",
    site: "127.0.0.1",
    title: "Order",
    value: { password: "hunter22", card: "4111 1111 1111 1111", jwt: "eyJa.eyJb.sig" },
    firedAt: new Date().toISOString(),
  });
  const pushed = await until(
    () => client.notes.filter((note) => note.method === "notifications/events/emitted").length >= 2,
    "pushed events",
  );
  assert.ok(pushed);
  const first = await client.call("events/poll", {
    name: "graft/routine.fired",
    cursor: "0",
    limit: 1,
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.hasMore, true);
  const payload = first.events[0].data;
  assert.deepEqual(Object.keys(payload).sort(), [
    "cursor",
    "firedAt",
    "routineId",
    "site",
    "title",
    "value",
  ]);
  assert.equal(payload.routineId, "r1");
  assert.equal(payload.value.price, 30);
  const resumed = await client.call("events/poll", {
    name: "graft/routine.fired",
    cursor: first.cursor,
  });
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].data.routineId, "r2");
  assert.equal(resumed.hasMore, false);
  const wire = JSON.stringify([first, resumed, client.notes]);
  for (const secret of [
    "551234",
    "482913",
    "abcdefghijklmnop1234",
    "hunter22",
    "4111 1111",
    "eyJa.eyJb",
  ])
    assert.ok(!wire.includes(secret), `leaked ${secret}`);
  const webhooks = await client.call("events/poll", { name: "graft/webhook.fired", cursor: "0" });
  assert.deepEqual(
    webhooks.events.map((event) => event.data.routineId),
    ["r2"],
  );
  assert.deepEqual(await client.call("events/unsubscribe", sub), { unsubscribed: true });
});

test("tasks: an irreversible call goes working -> input_required -> completed", async (t) => {
  const { client } = await fixture(t);
  await client.call("tools/list");
  const created = await client.call("tools/call", {
    name: "site__127_0_0_1__placeOrder",
    arguments: { q: "lamp" },
    task: { ttl: 60000 },
  });
  const { taskId } = created.task;
  assert.equal(created.task.status, "working");
  const asked = await until(async () => {
    const task = await client.call("tasks/get", { taskId });
    return task.status === "input_required" && task;
  }, "input_required");
  assert.equal(asked.inputRequest.kind, "confirm");
  const result = client.call("tasks/result", { taskId });
  await client.call("tasks/input", { taskId, response: { confirm: true } });
  const done = await result;
  assert.equal(done.isError, false, done.content?.[0]?.text);
  assert.equal(JSON.parse(done.content[0].text).result.items[0].name, "lamp");
  assert.equal((await client.call("tasks/get", { taskId })).status, "completed");
  const statuses = client.notes
    .filter((note) => note.method === "notifications/tasks/status" && note.params.taskId === taskId)
    .map((note) => note.params.status);
  assert.deepEqual(statuses, ["working", "input_required", "working", "completed"]);
});

test("tasks: a watch task completes on the next event and can be cancelled", async (t) => {
  const { client, data } = await fixture(t);
  const watch = await client.call("tasks/create", {
    name: "graft_watch",
    arguments: { cursor: "0" },
  });
  await appendEventLog(data, {
    kind: "watcher",
    routineId: "r9",
    site: "example.com",
    title: "Back in stock",
    value: true,
    firedAt: new Date().toISOString(),
  });
  const fired = await client.call("tasks/result", { taskId: watch.task.taskId });
  assert.equal(fired.structuredContent.data.routineId, "r9");
  const idle = await client.call("tasks/create", {
    name: "graft_watch",
    arguments: { cursor: "1" },
  });
  const cancelled = await client.call("tasks/cancel", { taskId: idle.task.taskId });
  assert.equal(cancelled.status, "cancelled");
  const after = await client.request("tasks/result", { taskId: idle.task.taskId });
  assert.ok(after.error);
});
