import assert from "node:assert/strict";
import test from "node:test";
import { recoverGrammarFunctionCall } from "@earendil-works/pi-ai/api/openai-responses-shared";

// The patched pi-ai: a grammar tool (codemode) called as a JSON function_call whose arguments are
// raw code kept `{}`, and replaying it threw "requires argument code to be a string" on the very
// next request, failing the run (gauntlet x1). The raw text becomes the tool's input.

const grammar = new Map([["codemode", "code"]]);

test("a grammar tool called with raw text as arguments keeps that text as its input", () => {
  const code = "const results = [];\nreturn results;";
  const block = {
    name: "codemode",
    arguments: {},
    argumentsError: `Unexpected token 'c' is not valid JSON\n\nReceived arguments:\n${code}`,
  };
  recoverGrammarFunctionCall(block, code, grammar);
  assert.deepEqual(block.arguments, { code });
  assert.equal(block.argumentsError, undefined);

  const streamed = {
    name: "codemode",
    arguments: {},
    argumentsError: `bad\n\nReceived arguments:\n${code}`,
  };
  recoverGrammarFunctionCall(streamed, undefined, grammar);
  assert.deepEqual(streamed.arguments, { code });
});

test("well-formed calls and ordinary JSON tools are left alone", () => {
  const ok = { name: "codemode", arguments: { code: "1" } };
  recoverGrammarFunctionCall(ok, '{"code":"1"}', grammar);
  assert.deepEqual(ok.arguments, { code: "1" });
  const other = { name: "site_mapper", arguments: {}, argumentsError: "bad" };
  recoverGrammarFunctionCall(other, "x", grammar);
  assert.deepEqual(other, { name: "site_mapper", arguments: {}, argumentsError: "bad" });
});
