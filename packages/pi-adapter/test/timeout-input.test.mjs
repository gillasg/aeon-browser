import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";
import { watchBudget } from "../dist/run-budget.js";

const ZOD_TIMEOUT = `[
  { "origin": "number", "code": "too_small", "minimum": 1000, "inclusive": true, "path": ["timeoutMs"], "message": "Too small: expected number to be >=1000" }
]`;

test("a zod timeout blob is one INVALID_INPUT line", async () => {
  const tool = createBrowserCodeTool("chat-zod", async () =>
    JSON.stringify({ error: ZOD_TIMEOUT }),
  );
  const result = await tool.execute("call-zod", { code: "await page.read()" });
  const text = JSON.stringify(result.content);
  assert.match(text, /INVALID_INPUT: timeoutMs must be an integer from 1000 to 600000/);
  assert.equal(text.includes("too_small"), false);
  assert.equal(result.isError, true);
});

test("a 1–999 ms cell timeout is raised to 1000 and the cell still runs", async () => {
  const chatId = "chat-clamp";
  let now = 1_000_000;
  let listener = () => undefined;
  const session = {
    subscribe(fn) {
      listener = fn;
      return () => undefined;
    },
    steer() {},
    abort() {},
    setActiveToolsByName() {},
    agent: { streamFunction() {} },
  };
  watchBudget(session, { maxMinutes: 10 }, chatId, () => now);
  now = 1_000_000 + 564_500;
  const seen = [];
  const tool = createBrowserCodeTool(chatId, async (_chat, _id, input) => {
    seen.push(input.codeCell.timeoutMs);
    return JSON.stringify({ output: "page text" });
  });
  try {
    const result = await tool.execute("call-clamp", { code: "await page.read()" });
    assert.deepEqual(seen, [1000]);
    assert.match(JSON.stringify(result.content), /\[warn\] timeoutMs raised to 1000 \(minimum\)/);
    assert.match(JSON.stringify(result.content), /page text/);
    assert.equal(result.isError, false);
  } finally {
    listener({ type: "agent_end" });
  }
});
