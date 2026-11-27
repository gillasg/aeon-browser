import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoutineScheduler } from "../dist/routine-scheduler.js";
import {
  deliverRoutineWebhook,
  sendWebhookOnce,
  signWebhook,
  webhookHeaders,
} from "../dist/routine-webhook.js";
import { postPinned } from "../dist/webhook-guard.js";
import { RETRY_DELAYS_MS, WebhookQueue } from "../dist/webhook-queue.js";
import { inferRoutineEffect, parseWebhook } from "../dist/routine-fields.js";

/** A clock the test moves by hand: timers fire only when it says so. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let timer;
  return {
    now: () => now,
    setTimer(run, ms) {
      timer = { at: now + ms, run };
      return { cancel: () => (timer = undefined) };
    },
    async advance(ms) {
      now += ms;
      if (timer && timer.at <= now) {
        const { run } = timer;
        timer = undefined;
        await run();
      }
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

const routine = {
  routineId: "routine-1",
  title: "Lamp price",
  webhook: { url: "https://hooks.example.com/hook", secret: "s3cret" },
};

test("a failing receiver is retried 10 s, 1 m, 5 m, 30 m and 2 h later, across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graft-webhook-queue-"));
  const file = join(dir, "q.sqlite");
  const tries = [];
  const clock = fakeClock();
  const failing = async () => (tries.push(clock.now()), { delivered: false, error: "HTTP 500" });
  try {
    let queue = new WebhookQueue(file, failing, clock);
    await deliverRoutineWebhook(routine, { price: 12 }, { queue });
    await clock.advance(0);
    assert.equal(tries.length, 1, "tried at once");
    assert.equal(queue.pending()[0].attempts, 1);
    queue.close();
    queue = new WebhookQueue(file, failing, clock);
    assert.equal(queue.pending().length, 1, "the queue survives a restart");
    for (const delay of RETRY_DELAYS_MS) {
      await clock.advance(delay - 1);
      const before = tries.length;
      await clock.advance(1);
      assert.equal(tries.length, before + 1, `retried after ${delay} ms`);
    }
    assert.deepEqual(
      tries.slice(1).map((t, i) => t - tries[i]),
      RETRY_DELAYS_MS,
    );
    assert.equal(queue.pending().length, 0, "given up after the last retry");
    queue.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delivery stops retrying once it lands", async () => {
  const clock = fakeClock();
  let n = 0;
  const queue = new WebhookQueue(
    ":memory:",
    async () => (++n < 3 ? { delivered: false, error: "HTTP 502" } : { delivered: true }),
    clock,
  );
  await deliverRoutineWebhook(routine, 1, { queue });
  await clock.advance(0);
  await clock.advance(RETRY_DELAYS_MS[0]);
  await clock.advance(RETRY_DELAYS_MS[1]);
  assert.equal(n, 3);
  assert.equal(queue.pending().length, 0);
  queue.close();
});

test("each try is signed over its timestamp and body, with a delivery id", async () => {
  const got = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.end("ok");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const queue = new WebhookQueue(":memory:", async () => ({ delivered: true }), fakeClock());
    await deliverRoutineWebhook(routine, { price: 12 }, { queue });
    const [item] = queue.pending();
    queue.close();
    const body = JSON.parse(item.body);
    assert.deepEqual(Object.keys(body), ["id", "routineId", "title", "value", "firedAt"]);
    const url = new URL(`http://hooks.example.com:${server.address().port}/hook`);
    const result = await postPinned(
      { url, address: "127.0.0.1", family: 4 },
      webhookHeaders(item, 1_700_000_000),
      item.body,
      5000,
    );
    assert.equal(result.status, 200);
    const sig = got[0].headers["x-graft-signature"];
    const mac = createHmac("sha256", "s3cret").update(`1700000000.${item.body}`).digest("hex");
    assert.equal(sig, `t=1700000000,v1=${mac}`);
    assert.equal(sig, signWebhook("s3cret", item.body, 1_700_000_000));
    assert.equal(got[0].headers["x-graft-delivery"], body.id);
    assert.equal(got[0].headers.host, url.host, "Host keeps the name, not the pinned address");
    const unsigned = webhookHeaders({ ...item, secret: null }, 1);
    assert.equal(unsigned["X-Graft-Signature"], undefined);
  } finally {
    server.close();
  }
});

test("sending refuses private addresses, and reports a redirect instead of following it", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/internal` });
    res.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = server.address().port;
    const item = { id: "d1", url: `http://127.0.0.1:${port}/hook`, secret: null, body: "{}" };
    const refused = await sendWebhookOnce(item);
    assert.equal(refused.delivered, false);
    assert.match(refused.error, /public host/);
    assert.deepEqual(hits, [], "a private literal is never connected to");
    const result = await postPinned(
      { url: new URL(`http://hooks.example.com:${port}/hook`), address: "127.0.0.1", family: 4 },
      {},
      "{}",
      5000,
    );
    assert.equal(result.status, 307);
    assert.deepEqual(hits, ["/hook"], "the redirect is not followed");
  } finally {
    server.close();
  }
});

test("webhook urls are http(s) and an effect override wins", () => {
  assert.equal(parseWebhook("https://example.com/hook", "s").secret, "s");
  assert.throws(() => parseWebhook("ftp://example.com/hook", undefined), /http/);
  assert.equal(
    inferRoutineEffect({
      title: "Watch",
      instruction: "Look",
      check: "true",
      webhookOnly: true,
    }),
    "read",
  );
  assert.equal(
    inferRoutineEffect({
      title: "Submit the order",
      instruction: "go",
      check: null,
      webhookOnly: true,
      override: undefined,
    }),
    "irreversible",
  );
  assert.equal(
    inferRoutineEffect({
      title: "Submit",
      instruction: "go",
      check: null,
      webhookOnly: false,
      override: "read",
    }),
    "read",
  );
});

test("a webhook-only run finishes at once while its receiver hangs", async () => {
  let delivering = 0;
  const queue = new WebhookQueue(
    ":memory:",
    () => (delivering++, new Promise(() => undefined)),
    fakeClock(),
  );
  const started = Date.now();
  const only = await run(
    { webhook: { url: "https://hooks.example.com/hook" }, webhookOnly: true },
    (r, v) => deliverRoutineWebhook(r, v, { queue }),
  );
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(only.invoked.length, 0);
  assert.equal(only.updates.at(-1).state, "completed");
  assert.equal(queue.pending().length, 1, "the delivery waits in the queue");
  queue.close();
  void delivering;
});

async function run(extra, deliver) {
  const runRecord = {
    runId: "run-watch",
    routineId: "routine-watch",
    chatId: "chat-watch",
    scheduledSlot: "2030-01-01T00:00:00.000Z",
    state: "due",
  };
  const routine = {
    routineId: runRecord.routineId,
    chatId: runRecord.chatId,
    title: "Flight price",
    instruction: "Tell me the price dropped.",
    check: "380",
    sites: [],
    enabled: true,
    deletedAt: null,
    requiredBrowserInstanceId: null,
    webhook: null,
    webhookOnly: false,
    effect: "write",
    ...extra,
  };
  const updates = [];
  const pins = [];
  const store = {
    listOpenRoutineRuns: () => [],
    listDueRoutines: () => [],
    listDueRoutineRuns: () =>
      updates.some((patch) => patch.state && patch.state !== "due") ? [] : [runRecord],
    getRoutine: () => routine,
    listRoutines: () => [routine],
    updateRoutineRun: (_runId, patch) => updates.push(patch),
  };
  const browser = {
    isInstanceAvailable: () => true,
    browserForChat: () => undefined,
    pinChat: (chatId, id) => pins.push({ chatId, id }),
    execute: async () => JSON.stringify({ value: { price: 380 } }),
  };
  const invoked = [];
  const chats = {
    getChat: () => ({ status: "ready" }),
    beginRoutineRun: () => undefined,
    endRoutineRun: () => undefined,
    withSession: async (_chatId, action) =>
      action({
        subscribeRoutineRuns: () => () => undefined,
        findRoutineRun: () => ({ state: "not-found" }),
        invokeRoutine: async (invocation) => {
          invoked.push(invocation);
          return { piEntryId: "entry-1" };
        },
      }),
  };
  const scheduler = new RoutineScheduler(store, chats, browser);
  scheduler.webhookDeliver = deliver;
  try {
    await scheduler.start();
    for (let i = 0; i < 50 && !updates.some((patch) => patch.state === "completed"); i += 1)
      await new Promise((done) => setTimeout(done, 20));
  } finally {
    scheduler.close();
  }
  return { updates, invoked, pins };
}
