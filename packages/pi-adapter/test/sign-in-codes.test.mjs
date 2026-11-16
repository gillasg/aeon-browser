import assert from "node:assert/strict";
import test from "node:test";
import { signInCodeGuard } from "../dist/sign-in-code-guard.js";

// A code the agent read for a sign-in is a secret: the answer must not repeat it. An order
// number, or digits the agent never read, stays. No wall-clock asserts.

function guard() {
  const handlers = {};
  signInCodeGuard().factory({ on: (event, fn) => (handlers[event] = fn) });
  return handlers;
}

test("a sign-in code read from a tool result is removed from the answer", () => {
  const handlers = guard();
  const noted = handlers.tool_result({
    content: [
      { type: "text", text: "Your verification code is 482913. It expires in 10 minutes." },
    ],
    isError: false,
  });
  assert.equal(noted, undefined, "the model still receives the result it needs to type the code");
  const ended = handlers.message_end({
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Signed in. The code was 482913." },
        { type: "thinking", thinking: "typed 482913 into the boxes" },
      ],
      stopReason: "stop",
    },
  });
  const text = ended.message.content.map((block) => block.text ?? block.thinking).join(" ");
  assert.match(text, /\[removed\]/);
  assert.equal(text.includes("482913"), false);
  const encoded = Buffer.from("482913").toString("base64").replace(/=+$/, "");
  const hidden = handlers.message_end({
    message: {
      role: "assistant",
      content: [{ type: "text", text: `saved as ${encoded}` }],
    },
  });
  assert.equal(hidden.message.content[0].text.includes(encoded), false);
  assert.match(hidden.message.content[0].text, /\[removed\]/);
});

test("an order number, a payment code and an unread number stay visible", () => {
  const handlers = guard();
  handlers.tool_result({
    content: [{ type: "text", text: "Order 482913 shipped. Payment code 110293 for $20." }],
    isError: false,
  });
  const ended = handlers.message_end({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Order 482913 shipped. Unread 770011." }],
    },
  });
  assert.equal(ended, undefined);
});
