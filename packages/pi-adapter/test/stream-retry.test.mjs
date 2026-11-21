/* global AbortController */
import assert from "node:assert/strict";
import test from "node:test";
import {
  honorAbort,
  installStreamRetry,
  markRunAborted,
  releaseLoopSignal,
} from "../dist/stream-retry.js";

const DROPPED = "OpenAI Responses stream ended before a terminal response event";

function fakeStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", partial: message };
    },
    result() {
      return Promise.resolve(message);
    },
  };
}

function sessionWith(produce) {
  const session = {
    agent: {
      streamFunction(_model, _context, options) {
        return produce(options?.signal);
      },
    },
  };
  return session;
}

async function read(session, signal) {
  const stream = await session.agent.streamFunction({}, {}, { signal });
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test("a dropped aborted stream is retried and the next success is the answer", async () => {
  const signals = [];
  const controller = new AbortController();
  const session = sessionWith((signal) => {
    signals.push(signal);
    if (signals.length === 1) {
      controller.abort();
      return fakeStream({ stopReason: "aborted", errorMessage: DROPPED });
    }
    return fakeStream({ stopReason: "stop", errorMessage: undefined, text: "prices" });
  });
  installStreamRetry(session, { sleep: async () => {}, baseDelayMs: 1 });
  const { message, events } = await read(session, controller.signal);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[1], controller.signal);
  assert.equal(signals[1].aborted, false);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.text, "prices");
  assert.equal(events.length, 1);
  assert.equal(controller.signal.aborted, false);
});

test("retries stop after the bound and the last error stays aborted", async () => {
  let calls = 0;
  const controller = new AbortController();
  const session = sessionWith(() => {
    calls += 1;
    controller.abort();
    return fakeStream({ stopReason: "aborted", errorMessage: DROPPED });
  });
  installStreamRetry(session, { sleep: async () => {}, maxRetries: 3, baseDelayMs: 1 });
  const { message } = await read(session, controller.signal);
  assert.equal(calls, 4);
  assert.equal(message.stopReason, "aborted");
  assert.equal(message.errorMessage, DROPPED);
});

test("a user abort and a billing error are not retried", async () => {
  const cases = ["Request was aborted", "insufficient_quota: billing"];
  for (const errorMessage of cases) {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const session = sessionWith(() => {
      calls += 1;
      return fakeStream({ stopReason: "aborted", errorMessage });
    });
    installStreamRetry(session, { sleep: async () => {}, baseDelayMs: 1 });
    const { message } = await read(session, controller.signal);
    assert.equal(calls, 1, errorMessage);
    assert.equal(message.errorMessage, errorMessage);
  }
});

test("an intentional abort is not retried, and a later live call can be", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const session = sessionWith((signal) => {
    calls += 1;
    if (signal.aborted) return fakeStream({ stopReason: "aborted", errorMessage: DROPPED });
    return fakeStream({ stopReason: "stop", text: "ok" });
  });
  installStreamRetry(session, { sleep: async () => {}, baseDelayMs: 1 });
  markRunAborted(session);
  const stopped = await read(session, controller.signal);
  assert.equal(calls, 0);
  assert.equal(stopped.message.stopReason, "aborted");
  const live = new AbortController();
  const again = await read(session, live.signal);
  assert.equal(again.message.stopReason, "stop");
});

test("stopReason error is left for Pi, and a live signal is not a dropped stream", async () => {
  let calls = 0;
  const session = sessionWith(() => {
    calls += 1;
    return fakeStream({ stopReason: "error", errorMessage: DROPPED });
  });
  installStreamRetry(session, { sleep: async () => {}, baseDelayMs: 1 });
  const errored = await read(session, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(errored.message.stopReason, "error");
  const deadline = sessionWith(() => {
    calls += 1;
    return fakeStream({ stopReason: "aborted", errorMessage: DROPPED });
  });
  installStreamRetry(deadline, { sleep: async () => {}, baseDelayMs: 1 });
  const capped = await read(deadline, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(capped.message.stopReason, "aborted");
});

test("a released loop signal stays quiet until a real abort", () => {
  const controller = new AbortController();
  controller.abort();
  let heard = 0;
  releaseLoopSignal(controller.signal);
  controller.signal.addEventListener("abort", () => {
    heard += 1;
  });
  assert.equal(controller.signal.aborted, false);
  assert.equal(heard, 0);
  honorAbort(controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.equal(heard, 1);
});
