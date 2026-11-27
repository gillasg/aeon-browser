import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { RoutineScheduler } from "../dist/routine-scheduler.js";
import { deliverRoutineWebhook, signWebhook } from "../dist/routine-webhook.js";
import { inferRoutineEffect, parseWebhook } from "../dist/routine-fields.js";

const routine = {
  routineId: "routine-1",
  title: "Lamp price",
  webhook: { url: "http://127.0.0.1/hook", secret: "s3cret" },
};

test("a webhook is signed, retried, then recorded", async () => {
  const slept = [];
  let tries = 0;
  const calls = [];
  const result = await deliverRoutineWebhook(
    routine,
    { price: 12 },
    {
      sleep: async (ms) => {
        slept.push(ms);
      },
      now: () => new Date("2026-11-21T00:00:00.000Z"),
      fetch: async (url, init) => {
        calls.push({ url, init });
        tries += 1;
        if (tries < 3) return { ok: false, status: 500 };
        return { ok: true, status: 200 };
      },
    },
  );
  assert.deepEqual(slept, [200, 800]);
  assert.equal(result.status, "delivered");
  assert.equal(result.attempts, 3);
  const body = calls[0].init.body;
  assert.deepEqual(Object.keys(JSON.parse(body)), ["routineId", "title", "value", "firedAt"]);
  assert.equal(
    calls[0].init.headers["X-Graft-Signature"],
    "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex"),
  );
  assert.equal(calls[0].init.headers["X-Graft-Signature"], signWebhook("s3cret", body));
  assert.equal(calls[0].init.headers["content-type"], "application/json");
});

test("three failures stay failed and an unsigned webhook has no signature", async () => {
  const slept = [];
  const failed = await deliverRoutineWebhook(
    { ...routine, webhook: { url: routine.webhook.url } },
    false,
    {
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetch: async (_url, init) => {
        assert.equal(init.headers["X-Graft-Signature"], undefined);
        return { ok: false, status: 502 };
      },
    },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 3);
  assert.equal(failed.error, "HTTP 502");
  assert.deepEqual(slept, [200, 800]);
  const network = await deliverRoutineWebhook(routine, 1, {
    sleep: async () => undefined,
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(network.status, "failed");
  assert.equal(network.error, "ECONNREFUSED");
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

test("a passing check posts the webhook and can skip the agent", async () => {
  const posted = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      posted.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        signature: request.headers["x-graft-signature"],
      });
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    const delivered = await run({
      webhook: { url: `http://127.0.0.1:${port}/hook`, secret: "s3cret" },
      webhookOnly: false,
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.routineId, "routine-watch");
    assert.equal(posted[0].body.value.price, 380);
    assert.equal(posted[0].signature, signWebhook("s3cret", JSON.stringify(posted[0].body)));
    assert.equal(delivered.invoked.length, 1);
    assert.equal(
      delivered.updates.find((patch) => patch.webhookDelivery)?.webhookDelivery.status,
      "delivered",
    );

    posted.length = 0;
    const only = await run({
      webhook: { url: `http://127.0.0.1:${port}/hook` },
      webhookOnly: true,
      requiredBrowserInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(only.invoked.length, 0);
    assert.equal(posted[0].signature, undefined);
    assert.equal(only.updates.at(-1).state, "completed");
    assert.equal(only.updates.at(-1).webhookDelivery.status, "delivered");
    assert.equal(only.pins.length, 1);
    assert.equal(only.pins[0].id, "11111111-1111-4111-8111-111111111111");
  } finally {
    server.close();
  }
});

async function run(extra) {
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
  try {
    await scheduler.start();
    for (let i = 0; i < 50 && !updates.some((patch) => patch.webhookDelivery); i += 1)
      await new Promise((done) => setTimeout(done, 20));
  } finally {
    scheduler.close();
  }
  return { updates, invoked, pins };
}
