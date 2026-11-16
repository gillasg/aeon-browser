import assert from "node:assert/strict";
import test from "node:test";
import { browserCodeGuidelines } from "../dist/browser-code-guidance.js";

// Agent text is the model's only instruction source; these rules are user decisions that a later
// edit must not quietly undo (decisions.md: "Agent core", "Which tabs an agent may use").
test("the answer channel forbids narrating the next step and keeps the task as the go-ahead", () => {
  const text = browserCodeGuidelines.join("\n");
  assert.match(text, /Do not narrate the next step between cells/);
  assert.match(text, /The pill and the step lines show progress; the task is the go-ahead/);
  assert.match(text, /Submit, send, pay or post only when the task asked/);
});

test("the removed official-forms stop stays removed", () => {
  const text = browserCodeGuidelines.join("\n");
  assert.doesNotMatch(text, /stop before the final submit/i);
  assert.doesNotMatch(text, /government, university, school, court/i);
});
