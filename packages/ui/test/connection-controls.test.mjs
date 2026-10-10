import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerPanels } from "../dist/composer-panels.js";
import { HomeStart } from "../dist/home-start.js";

const model = {
  provider: "fixture",
  id: "cached",
  name: "Cached model",
  thinkingLevels: ["high"],
  defaultThinkingLevel: "high",
};
const controls = {
  effectiveModel: model,
  availableModels: [model],
  thinkingLevel: "high",
  availableThinkingLevels: ["high"],
  steeringQueue: [],
  followUpQueue: [],
};
test("disconnected chat hides cached model, thinking, usage, and tool controls", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerPanels, { connected: false, controls, attachments: [] }),
  );
  assert.match(html, /Connecting/);
  assert.doesNotMatch(html, /Cached model|model-picker|thinking-picker|pi-tools-toggle/);
});
test("new tab hides its saved model catalog while disconnected", () => {
  const html = renderToStaticMarkup(
    createElement(HomeStart, {
      active: [],
      props: {
        connected: false,
        projectId: "",
        modelCatalog: { defaultModel: model, models: [model] },
        homeRoutines: [],
        openChatIds: new Set(),
        onAsk() {},
        onOpenChat() {},
        onCatalog() {},
        onManageRoutines() {},
      },
    }),
  );
  assert.match(html, /Connecting/);
  assert.doesNotMatch(html, /Cached model|home-model-picker|home-thinking-picker/);
});
