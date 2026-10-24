import assert from "node:assert/strict";
import test from "node:test";
import { installBrowserSessionLifecycle } from "../dist/browser-session-lifecycle.js";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function fakeSession() {
  let listener;
  return {
    subscribe(fn) {
      listener = fn;
      return () => undefined;
    },
    emit(event) {
      listener(event);
    },
  };
}

function recordingRunner() {
  const calls = [];
  let tabOpen = true;
  return {
    calls,
    get tabOpen() {
      return tabOpen;
    },
    run(chatId, toolCallId, input) {
      calls.push({ chatId, toolCallId, input });
      if (input.tidy === true) tabOpen = false;
      return Promise.resolve();
    },
  };
}

test("run-end tidy waits for the delay, then closes the tabs", async () => {
  const session = fakeSession();
  const runner = recordingRunner();
  installBrowserSessionLifecycle(session, "chat-delay", runner.run, { tidyDelayMs: 40 });

  session.emit({ type: "agent_end" });
  await wait(15);
  assert.equal(runner.tabOpen, true);
  assert.deepEqual(runner.calls[0], {
    chatId: "chat-delay",
    toolCallId: "browser-turn-cleanup",
    input: { release: true },
  });

  await wait(60);
  assert.equal(runner.tabOpen, false);
  assert.deepEqual(runner.calls.at(-1).input, { release: true, tidy: true });
});

test("a follow-up run cancels the pending tidy and keeps its tabs", async () => {
  const session = fakeSession();
  const runner = recordingRunner();
  installBrowserSessionLifecycle(session, "chat-follow-up", runner.run, { tidyDelayMs: 80 });

  session.emit({ type: "agent_end" });
  await wait(10);
  session.emit({ type: "agent_start" });
  await wait(110);

  assert.equal(runner.tabOpen, true);
  assert.equal(runner.calls.length, 1);

  session.emit({ type: "agent_end" });
  await wait(15);
  assert.equal(runner.tabOpen, true);
  await wait(90);
  assert.equal(runner.tabOpen, false);
  assert.deepEqual(runner.calls.at(-1).input, { release: true, tidy: true });
});
