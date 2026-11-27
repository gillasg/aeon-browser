import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelAccounts, filterKeyProviders } from "../dist/model-accounts.js";
import { ModelSignInPanel } from "../dist/model-sign-in-panel.js";
import { connectionBadge, defaultModelName } from "../dist/model-accounts-types.js";

const keyMethod = (name) => [{ type: "api_key", label: `${name} API key`, subscription: false }];
const providers = [
  {
    id: "anthropic",
    name: "Anthropic",
    methods: [
      { type: "oauth", label: "Sign in with Claude", subscription: true },
      ...keyMethod("Anthropic"),
    ],
    connected: true,
    connection: { type: "oauth", stored: true },
  },
  {
    id: "groq",
    name: "Groq",
    methods: keyMethod("Groq"),
    connected: true,
    connection: { type: "api_key", source: "GROQ_API_KEY", stored: false },
  },
  { id: "cerebras", name: "Cerebras", methods: keyMethod("Cerebras"), connected: false },
  { id: "openrouter", name: "OpenRouter", methods: keyMethod("OpenRouter"), connected: false },
];
const state = {
  providers,
  models: [{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" }],
  defaultModel: { provider: "anthropic", model: "claude-opus-5-5" },
};
const noop = () => undefined;
const props = (overrides = {}) => ({
  state,
  flow: null,
  error: "",
  onShow: noop,
  onHide: noop,
  onStart: noop,
  onAnswer: noop,
  onCancel: noop,
  onCloseFlow: noop,
  onSignOut: noop,
  onDefaultModel: noop,
  onOpenUrl: noop,
  ...overrides,
});

test("badges tell subscriptions, saved keys and environment credentials apart", () => {
  assert.equal(connectionBadge(providers[0]), "Subscription");
  assert.equal(connectionBadge(providers[1]), "Environment");
  assert.equal(
    connectionBadge({ ...providers[2], connection: { type: "api_key", stored: true } }),
    "API key",
  );
  assert.equal(connectionBadge(providers[2]), undefined);
  assert.equal(defaultModelName(state), "Claude Opus 5.5");
  assert.equal(defaultModelName({ ...state, defaultModel: undefined }), undefined);
});

test("the API-key list starts on popular and connected providers; a search covers them all", () => {
  const ids = (list) => list.map((provider) => provider.id);
  assert.deepEqual(ids(filterKeyProviders(providers, "", true)), [
    "anthropic",
    "groq",
    "openrouter",
  ]);
  assert.deepEqual(ids(filterKeyProviders(providers, "", false)), ids(providers));
  assert.deepEqual(ids(filterKeyProviders(providers, "cere", true)), ["cerebras"]);
  assert.deepEqual(ids(filterKeyProviders(providers, "OPENROUTER", true)), ["openrouter"]);
});

test("with a model ready, the Models page offers the way back to work", () => {
  const html = renderToStaticMarkup(
    createElement(ModelAccounts, props({ onStartChat: noop, startChatLabel: "Return to Graft" })),
  );
  assert.match(html, /You&#x27;re ready\./);
  assert.match(html, /Graft uses Claude Opus 5\.5 by default/);
  assert.match(html, /Return to Graft<\/button>/);
  assert.match(html, /model-badge">Subscription/);
  assert.match(html, /model-badge">Environment/);
  assert.match(html, /Already set by GROQ_API_KEY/);
  assert.match(html, /Show all 4 providers/);
  assert.doesNotMatch(html, /Cerebras/, "unpopular providers wait behind All or a search");
});

test("a finished sign-in confirms the default model and offers Start chatting", () => {
  const flow = { provider: providers[0], method: "oauth", notes: [], result: { kind: "done" } };
  const html = renderToStaticMarkup(
    createElement(ModelSignInPanel, { ...props({ onStartChat: noop }), flow }),
  );
  assert.match(html, /Connected to Anthropic\./);
  assert.match(html, /Graft will use Claude Opus 5\.5/);
  assert.match(html, /Start chatting<\/button>/);
  assert.match(html, /Connect another<\/button>/);
  const plain = renderToStaticMarkup(createElement(ModelSignInPanel, { ...props(), flow }));
  assert.match(plain, /Done<\/button>/);
  assert.doesNotMatch(plain, /Start chatting/);
});

test("the sign-in grid skips connected providers and drops the redundant Subscription badge", () => {
  const xai = {
    id: "xai",
    name: "xAI",
    methods: [{ type: "oauth", label: "Sign in with X", subscription: true }],
    connected: true,
    connection: { type: "oauth", stored: true },
  };
  const codex = {
    id: "openai-codex",
    name: "OpenAI Codex",
    methods: [{ type: "oauth", label: "ChatGPT Plus or Pro", subscription: true }],
    connected: false,
  };
  const html = renderToStaticMarkup(
    createElement(ModelAccounts, {
      ...props(),
      state: { ...props().state, providers: [xai, codex] },
    }),
  );
  const grid = html.slice(html.indexOf('id="models-subscriptions"'));
  assert.match(grid, /OpenAI Codex/);
  assert.doesNotMatch(grid.slice(0, grid.indexOf("</section>")), /xAI|model-badge/);
});
