import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLeakedToolCallMarkup,
  leakedToolCallGuard,
  parseLeakedToolCalls,
} from "../dist/leaked-tool-call-guard.js";

const leaked = `<｜DSML｜ calls>
<｜DSML｜ invoke name="browser_code">
<｜DSML｜ parameter name="code" string="true">const t = await browser.tabs();
return t.filter(x => x.url.includes('creepjs'));</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

test("the DeepSeek leak is detected and parsed into the real tool call", () => {
  assert.equal(hasLeakedToolCallMarkup(leaked), true);
  const calls = parseLeakedToolCalls(leaked);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "browser_code");
  assert.match(calls[0].arguments.code, /browser\.tabs\(\)/);
  assert.match(calls[0].arguments.code, /creepjs/);
});

test("several invokes, escaped entities and ASCII bars all parse", () => {
  const text = `<|DSML| calls>
<|DSML| invoke name="browser_code"><|DSML| parameter name="code" string="true">return &quot;x&quot; &amp; y;</|DSML| parameter></|DSML| invoke>
<|DSML| invoke name="browser_context"><|DSML| parameter name="query">{"q":1}</|DSML| parameter></|DSML| invoke>
</|DSML| calls>`;
  const calls = parseLeakedToolCalls(text);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["browser_code", "browser_context"],
  );
  assert.equal(calls[0].arguments.code, 'return "x" & y;');
  assert.deepEqual(calls[1].arguments.query, { q: 1 });
});

test("ordinary answers are left alone", () => {
  assert.equal(hasLeakedToolCallMarkup("The order total is $42 and it shipped."), false);
  assert.equal(hasLeakedToolCallMarkup("Use page.getByRole('button') to click."), false);
  assert.deepEqual(parseLeakedToolCalls("Here is the answer."), []);
});

function guard() {
  const handlers = new Map();
  const sent = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (text, options) => sent.push({ text, options }),
  };
  leakedToolCallGuard().factory(pi);
  return { messageEnd: handlers.get("message_end"), agentStart: handlers.get("agent_start"), sent };
}

test("the guard replaces leaked text with an executable tool call", () => {
  const { messageEnd } = guard();
  const result = messageEnd({
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: leaked }] },
  });
  assert.ok(result, "the message was replaced");
  assert.equal(result.message.stopReason, "toolUse");
  const text = result.message.content.filter((block) => block.type === "text");
  assert.equal(text.length, 0, "the markup is never shown as the answer");
  const call = result.message.content.find((block) => block.type === "toolCall");
  assert.equal(call.name, "browser_code");
  assert.match(call.arguments.code, /browser\.tabs\(\)/);
  assert.ok(call.id, "the tool call has an id");
});

test("unknown tool markup is stripped and re-prompted once", () => {
  const { messageEnd, agentStart, sent } = guard();
  const message = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "<|tool_call|>browser_code<|tool_call|>" }],
  };
  const first = messageEnd({ message });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.deliverAs, "steer");
  assert.ok(!JSON.stringify(first.message.content).includes("tool_call"));
  messageEnd({ message });
  assert.equal(sent.length, 1, "no re-prompt loop");
  agentStart();
  messageEnd({ message });
  assert.equal(sent.length, 2, "a new run may re-prompt once");
});

test("a clean assistant message is returned untouched", () => {
  const { messageEnd } = guard();
  const message = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Done." }],
  };
  assert.equal(messageEnd({ message }), undefined);
});
