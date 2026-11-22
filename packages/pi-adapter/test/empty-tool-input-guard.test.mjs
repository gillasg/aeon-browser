import assert from "node:assert/strict";
import test from "node:test";
import { fillMissingStringInputs, singleStringInput } from "../dist/empty-tool-input-guard.js";

const codemode = {
  name: "codemode",
  parameters: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
};
const other = {
  name: "site_mapper",
  parameters: { type: "object", required: ["action"], properties: { action: { type: "number" } } },
};

test("a tool whose one input is a string is recognised", () => {
  assert.equal(singleStringInput(codemode.parameters), "code");
  assert.equal(singleStringInput(other.parameters), undefined);
  assert.equal(singleStringInput({ type: "object", required: ["a", "b"] }), undefined);
  assert.equal(singleStringInput(null), undefined);
});

test("a call with no arguments gets an empty string input instead of failing every later turn", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: "trying" },
      { type: "toolCall", id: "1", name: "codemode", arguments: {} },
      { type: "toolCall", id: "2", name: "site_mapper", arguments: {} },
    ],
  };
  const fixed = fillMissingStringInputs(message, [codemode, other]);
  assert.deepEqual(fixed.content[1].arguments, { code: "" });
  assert.deepEqual(fixed.content[2].arguments, {});
  assert.equal(fixed.content[0].text, "trying");
});

test("a well-formed call is left alone", () => {
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "codemode", arguments: { code: "1" } }],
  };
  assert.equal(fillMissingStringInputs(message, [codemode]), undefined);
});
