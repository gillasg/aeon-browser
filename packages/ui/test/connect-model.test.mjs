import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerPanels } from "../dist/composer-panels.js";
import { HomeStart } from "../dist/home-start.js";

const home = (overrides) =>
  renderToStaticMarkup(
    createElement(HomeStart, {
      active: [],
      props: {
        connected: true,
        projectId: "",
        modelCatalog: { defaultModel: null, models: [] },
        homeRoutines: [],
        openChatIds: new Set(),
        onAsk() {},
        onOpenChat() {},
        onCatalog() {},
        onManageRoutines() {},
        onConnectModel() {},
        ...overrides,
      },
    }),
  );

test("with no model connected, the new tab offers Connect a model instead of an empty picker", () => {
  const html = home({});
  assert.match(html, /Connect an AI model to start/);
  assert.match(html, /Connect a model<\/button>/);
  assert.doesNotMatch(html, /home-model-picker|Loading model/);
});

test("while signing in, the card says so and offers to reopen the page", () => {
  const html = home({ modelLogin: { waiting: true } });
  assert.match(html, /Finish signing in/);
  assert.match(html, /Open sign-in again/);
});

test("a sign-in error is shown on the card", () => {
  const html = home({
    modelLogin: { waiting: false, error: "Aeon could not open the sign-in page." },
  });
  assert.match(html, /role="alert"[^>]*>Aeon could not open the sign-in page\./);
});

test("a chat with no models shows the same card in the composer", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerPanels, {
      connected: true,
      controls: {
        effectiveModel: null,
        availableModels: [],
        thinkingLevel: "",
        availableThinkingLevels: [],
        steeringQueue: [],
        followUpQueue: [],
      },
      attachments: [],
      onManageModels() {},
    }),
  );
  assert.match(html, /Connect an AI model to start/);
});
