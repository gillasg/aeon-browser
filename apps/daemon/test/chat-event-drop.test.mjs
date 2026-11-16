import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { startDevHandshakeServer } from "../dist/dev-harness.js";
import { ChatService, closeProjectServices } from "./chat-service-fixture.mjs";
import { connectDevUi, requestId } from "./dev-chat-client.mjs";
import { openChatStore } from "@aeon/store";

const DEV_GRANT = "A".repeat(43);

// A Pi session that lets the test publish the events the daemon would otherwise get from Pi.
function createControllablePort() {
  const listeners = new Set();
  const entries = [
    {
      entryId: "entry-1",
      parentEntryId: null,
      category: "message",
      timestamp: new Date().toISOString(),
      message: null,
      futureEntryField: true,
    },
  ];
  return {
    port: {
      openOrCreate: async (input) => {
        const reference = input.reference ?? {
          sessionId: input.activationId,
          sessionFile: join(input.workingDirectory, `${input.activationId}.jsonl`),
        };
        return {
          reference,
          submit: async () => {},
          queue: async () => {},
          abort: async () => {},
          controls: () => ({
            effectiveModel: null,
            availableModels: [],
            thinkingLevel: "off",
            availableThinkingLevels: [],
            steeringQueue: [],
            followUpQueue: [],
            active: false,
          }),
          setModel: async () => {},
          setThinkingLevel: () => {},
          snapshot: () => ({
            reference,
            workingDirectory: input.workingDirectory,
            entries,
            materialized: false,
            active: false,
            runState: "idle",
            contextUsage: null,
          }),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close: () => {},
        };
      },
      searchTranscript: async () => undefined,
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

async function startChat(t) {
  const dataDirectory = resolve(await mkdtemp(join(tmpdir(), "aeon-event-drop-")));
  assert.ok(dataDirectory.startsWith(`${resolve(tmpdir())}${sep}`));
  const store = openChatStore(dataDirectory);
  const controllable = createControllablePort();
  const service = new ChatService({ dataDirectory, store, pi: controllable.port });
  const daemon = await startDevHandshakeServer({
    chatService: service,
    port: 0,
    grant: DEV_GRANT,
    printGrant: false,
  });
  const view = await connectDevUi(daemon.url, DEV_GRANT);
  t.after(async () => {
    await view.close();
    await daemon.close();
    closeProjectServices(dataDirectory);
    store.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const draft = await service.createDraft();
  await service.submitPrompt(draft.chatId, "Fill the order form.");
  const subscribeId = requestId();
  view.send({ kind: "chat.subscribe", requestId: subscribeId, chatId: draft.chatId });
  const snapshot = await view.waitFor(
    (message) => message.kind === "chat.snapshot" && message.requestId === subscribeId,
  );
  return { view, snapshot, controllable };
}

function toolMessage(toolCallId, actions) {
  return {
    kind: "message-end",
    message: {
      role: "tool",
      content: [{ type: "text", text: "Filled." }],
      toolCallId,
      toolName: "browser_code",
      ...(actions ? { actions } : {}),
    },
  };
}

function chatEvent(view, snapshot, toolCallId) {
  return view.waitFor(
    (message) =>
      message.kind === "chat.event" &&
      message.subscriptionId === snapshot.subscriptionId &&
      message.event.event.kind === "message-end" &&
      message.event.event.message.toolCallId === toolCallId,
  );
}

test("a chat event the view cannot parse is repaired or dropped, and the run keeps going", async (t) => {
  const { view, snapshot, controllable } = await startChat(t);
  // The stored entry carried a field this build does not know: the snapshot still opens, with
  // just that field gone.
  assert.equal(snapshot.snapshot.entries.length, 1);
  assert.equal(snapshot.snapshot.entries[0].entryId, "entry-1");
  assert.equal("futureEntryField" in snapshot.snapshot.entries[0], false);

  const logged = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    logged.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    // A field the engine added that this build's schema does not know yet: the view drops just
    // that field, and the action keeps its effect and evidence.
    assert.doesNotThrow(() =>
      controllable.emit(
        toolMessage("call-repaired", [
          {
            kind: "click",
            tStart: 100,
            tEnd: 180,
            effect: "confirmed",
            evidence: "navigation to https://shop.test/orders",
            futureEngineField: true,
          },
        ]),
      ),
    );
    const repaired = await chatEvent(view, snapshot, "call-repaired");
    assert.deepEqual(repaired.event.event.message.actions, [
      {
        kind: "click",
        tStart: 100,
        tEnd: 180,
        effect: "confirmed",
        evidence: "navigation to https://shop.test/orders",
      },
    ]);

    // Drift that cannot be repaired: a trace action with no timing. This is the shape that used
    // to throw out of the event hub and end the run.
    assert.doesNotThrow(() =>
      controllable.emit(toolMessage("call-bad", [{ kind: "click", effect: "confirmed" }])),
    );
    // The very next event still reaches the view on the same subscription.
    controllable.emit(toolMessage("call-good"));
    const delivered = await chatEvent(view, snapshot, "call-good");
    assert.equal(delivered.event.event.message.toolName, "browser_code");
  } finally {
    process.stderr.write = write;
  }
  assert.ok(
    logged.some((line) => line.includes("dropped unknown fields from a message-end chat event")),
    `expected a repair log, got: ${logged.join("")}`,
  );
  assert.ok(
    logged.some((line) => line.includes("dropped a message-end chat event")),
    `expected a drop log, got: ${logged.join("")}`,
  );
});
