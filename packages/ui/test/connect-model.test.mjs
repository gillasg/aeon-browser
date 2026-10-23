import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerPanels } from "../dist/composer-panels.js";
import { HomeStart } from "../dist/home-start.js";
import { HomeTopBar } from "../dist/home-top-bar.js";

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

const model = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  thinkingLevels: ["low"],
  defaultThinkingLevel: "low",
};
const controls = {
  effectiveModel: { provider: model.provider, id: model.id, name: model.name },
  availableModels: [model],
  thinkingLevel: "low",
  availableThinkingLevels: ["low"],
  steeringQueue: [],
  followUpQueue: [],
};

test("a failed sign-in from the model picker is shown next to it", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerPanels, {
      connected: true,
      controls,
      modelLogin: { waiting: false, error: "Aeon could not open the sign-in page." },
      attachments: [],
      onManageModels() {},
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Aeon could not open the sign-in page\./);
  assert.match(html, /id="model-picker"/);
});

test("a Chat whose model cannot start says why and offers Sign in again", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerPanels, {
      connected: true,
      controls: null,
      controlsError:
        'opencode-go/deepseek-v4.1-flash isn\'t available. Sign in to opencode-go again from the model picker ("Add or manage models…").',
      attachments: [],
      onManageModels() {},
    }),
  );
  assert.doesNotMatch(html, /Starting/);
  assert.match(html, /This Chat can&#x27;t start/);
  assert.match(html, /isn&#x27;t available/);
  assert.match(html, />Sign in again<\/button>/);
});

test("a failed sign-in from the home picker is shown there too", () => {
  const html = home({
    modelCatalog: { defaultModel: model, models: [model] },
    modelLogin: { waiting: false, error: "Aeon could not open the sign-in page." },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Aeon could not open the sign-in page\./);
  assert.match(html, /id="home-model-picker"/);
});

test("the home top bar has no brand and keeps the page tabs on the right", () => {
  const html = renderToStaticMarkup(
    createElement(HomeTopBar, { view: "chats", activityCount: 0, onView() {} }),
  );
  assert.doesNotMatch(html, /home-top-brand|Aeon home/);
  assert.match(html, /class="home-top-nav"/);
  assert.match(html, /aria-current="page"[^>]*>Chats/);
});
