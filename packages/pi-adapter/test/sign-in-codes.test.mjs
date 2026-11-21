import assert from "node:assert/strict";
import test from "node:test";
import { signInCodeGuard } from "../dist/sign-in-code-guard.js";
import { signInCodes, maskAnswerBlock } from "../dist/sign-in-codes.js";

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

test("codes are kept per chat, so one chat cannot mask another chat's answer", () => {
  const a = signInCodes("chat-a");
  const b = signInCodes("chat-b");
  a.note("Your verification code is 482913.");
  assert.equal(signInCodes("chat-a"), a, "the same chat reuses its store");
  assert.notEqual(a, b);
  assert.match(a.mask("the code is 482913"), /\[removed\]/);
  assert.equal(b.mask("the code is 482913").includes("482913"), true, "b never noted that code");
});

test("a streaming answer block is masked, and an unchanged block is reused", () => {
  const codes = signInCodes("chat-stream");
  codes.note("Your verification code is 339120.");
  const typed = { type: "text", text: "Code 339120 typed" };
  const masked = maskAnswerBlock(codes, typed);
  assert.equal(masked.text.includes("339120"), false);
  assert.match(masked.text, /\[removed\]/);
  const thinking = { type: "thinking", thinking: "enter 339120" };
  assert.match(maskAnswerBlock(codes, thinking).thinking, /\[removed\]/);
  const clean = { type: "text", text: "nothing secret here" };
  assert.equal(maskAnswerBlock(codes, clean), clean, "a clean block is not reallocated");
});

test("numeric ids in link paths are never taken for codes or removed", () => {
  const codes = signInCodes("url-ids-chat");
  codes.note("Sony PS5 https://www.croma.com/sony-ps5/p/311738 in stock");
  const link = "Buy it: https://www.croma.com/sony-ps5/p/311738 and https://amazon.in/dp/123456";
  assert.equal(codes.mask(link), link);
  codes.note("Your verification code is 311738.");
  assert.equal(codes.mask(link), link, "the same digits in a path stay even once they are a code");
  assert.equal(codes.mask("The code was 311738."), "The code was [removed].");
  assert.equal(
    codes.mask("https://site.test/items/12345678?code=311738&token=abc"),
    "https://site.test/items/12345678?code=[removed]&token=abc",
  );
});
