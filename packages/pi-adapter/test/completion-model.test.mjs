import assert from "node:assert/strict";
import test from "node:test";
import { chooseCompletionModel } from "../dist/completion-model.js";

const models = [
  { provider: "anthropic", id: "claude-sonnet" },
  { provider: "opencode-go", id: "deepseek-v4.1-flash" },
];
const defaults = (provider, id) => ({
  getDefaultProvider: () => provider,
  getDefaultModel: () => id,
});
const preferred = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

test("a named model that is gone fails instead of using another one", () => {
  assert.throws(
    () => chooseCompletionModel(models, defaults(), { model: "openai/gpt-6" }, preferred),
    (error) =>
      /openai\/gpt-6 isn't available/.test(error.message) &&
      /Sign in to openai again from the model picker/.test(error.message) &&
      /Add or manage models/.test(error.message),
  );
});

test("a stored default that is gone fails instead of using another one", () => {
  assert.throws(
    () => chooseCompletionModel(models, defaults("openai", "gpt-6"), {}, undefined),
    /openai\/gpt-6 isn't available\. Sign in to openai again from the model picker/,
  );
});

test("Aeon's preferred model that is gone fails when no default replaces it", () => {
  assert.throws(
    () => chooseCompletionModel(models, defaults(), {}, { provider: "opencode-go", id: "gone" }),
    /opencode-go\/gone isn't available\. Sign in to opencode-go again/,
  );
});

test("a stored default is used when the preferred model is gone", () => {
  assert.deepEqual(
    chooseCompletionModel(
      models,
      defaults("anthropic", "claude-sonnet"),
      {},
      { provider: "opencode-go", id: "gone" },
    ),
    { provider: "anthropic", id: "claude-sonnet" },
  );
});

test("nothing chosen or set uses the first connected model", () => {
  assert.deepEqual(chooseCompletionModel(models, defaults(), {}, undefined), models[0]);
});

test("a named model and the preferred model are used when they exist", () => {
  assert.deepEqual(
    chooseCompletionModel(models, defaults(), { model: "anthropic/claude-sonnet" }, preferred),
    models[0],
  );
  assert.deepEqual(chooseCompletionModel(models, defaults(), {}, preferred), models[1]);
});

test("no connected model explains how to connect one", () => {
  assert.throws(
    () => chooseCompletionModel([], defaults(), {}, undefined),
    /No AI model is connected\. Sign in from the model picker/,
  );
});

test("a bare model name asks for provider/model", () => {
  assert.throws(
    () => chooseCompletionModel(models, defaults(), { model: "claude-sonnet" }, undefined),
    /Choose a model as provider\/model/,
  );
});
