import assert from "node:assert/strict";
import test from "node:test";
import { deliveryReserveMs, modelRequestTimeoutMs, watchBudget } from "../dist/run-budget.js";

test("the reserve is the smaller of 10% and 30s", () => {
  assert.equal(deliveryReserveMs(600_000), 30_000);
  assert.equal(deliveryReserveMs(120_000), 12_000);
  assert.equal(deliveryReserveMs(20_000), 2_000);
});

test("a fixture model that burns the budget in a cell still answers", async () => {
  const { createBrowserCodeTool } = await import("../dist/browser-code-tool.js");
  const chatId = "chat-reserve";
  let now = 1_000_000;
  const tools = ["browser_code", "read"];
  const steered = [];
  const aborted = [];
  const timeouts = [];
  let listener = () => undefined;
  let seenSignal;
  const session = {
    subscribe(fn) {
      listener = fn;
      return () => undefined;
    },
    steer(text) {
      steered.push(text);
    },
    abort() {
      aborted.push(1);
    },
    setActiveToolsByName(names) {
      tools.splice(0, tools.length, ...names);
    },
    agent: {
      streamFunction(_model, _context, options) {
        const stream = {
          signal: options?.signal,
          result: () => Promise.resolve({}),
        };
        seenSignal = stream.signal;
        return stream;
      },
    },
  };
  watchBudget(session, { maxMinutes: 10 }, chatId, () => now);
  session.agent.streamFunction({}, {});
  assert.ok(seenSignal, "a model request is capped");
  assert.equal(modelRequestTimeoutMs(chatId), 570_000);

  const tool = createBrowserCodeTool(chatId, async (_chat, _id, input) => {
    timeouts.push(input.codeCell.timeoutMs);
    // Sixty seconds of work would run through the reserve. A shorter cap is the cut.
    if (input.codeCell.timeoutMs >= 60_000) return JSON.stringify({ output: "burned the budget" });
    return JSON.stringify({ output: "partial checkpoint" });
  });
  now = 1_000_000 + 550_000;
  const late = await tool.execute("call-1", { code: "burn()" });
  assert.equal(timeouts.at(-1), 15_000);
  assert.match(JSON.stringify(late.content), /partial checkpoint/);

  now = 1_000_000 + 570_000;
  listener({ type: "tool_execution_end" });
  assert.deepEqual(tools, []);
  assert.equal(steered.length, 0);
  assert.equal(aborted.length, 0);
  assert.equal(modelRequestTimeoutMs(chatId), 30_000);

  let ran = false;
  const blocked = createBrowserCodeTool(chatId, async () => {
    ran = true;
    return JSON.stringify({ output: "should not run" });
  });
  const refused = await blocked.execute("call-2", { code: "again()" });
  assert.equal(ran, false);
  assert.match(JSON.stringify(refused.content), /time budget is spent/);

  const answer =
    tools.length === 0 ? "Delivered: partial checkpoint is in the workspace." : undefined;
  assert.equal(answer, "Delivered: partial checkpoint is in the workspace.");
  listener({ type: "agent_end" });
});
