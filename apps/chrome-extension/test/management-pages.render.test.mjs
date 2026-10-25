import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationsPanel, SitesPanel, SiteSessionsPanel } from "@aeon/ui";

// A real render of the two management pages: server-rendered React with a fixture snapshot, so a
// broken prop, a missing import or a template that throws fails here, not only in the browser.

const chat = {
  chatId: "11111111-1111-4111-8111-111111111111",
  title: "Test chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  archived: false,
  pinned: false,
  origin: "user",
  messageCount: 0,
};

const snapshot = {
  chats: [chat],
  routines: [],
  pins: [],
  capabilityRevision: 0,
  capabilities: [],
  resources: null,
  resourceError: null,
  signIn: { provider: null, state: "not_set_up" },
  workflows: [
    {
      name: "Daily prices",
      slug: "daily-prices",
      steps: 3,
      description: "Reads three shops",
      updatedAt: new Date().toISOString(),
      inputs: [{ name: "query", required: true, default: "lamp" }],
      running: false,
      lastRun: { state: "ok", at: new Date().toISOString(), error: null },
    },
  ],
  sites: [
    {
      site: "shop.example",
      operations: 12,
      updatedAt: new Date().toISOString(),
      health: "ok",
      session: true,
      sessionAccount: "test@example.com",
      sessionSavedAt: new Date().toISOString(),
      recording: false,
      suggestions: ["Add a search operation"],
      recipes: [{ name: "search", kind: "items", fields: 4, updatedAt: new Date().toISOString() }],
    },
  ],
  lastAction: { ok: true, at: new Date().toISOString(), message: "Exported to /tmp/x.json" },
};

const props = {
  section: "automations",
  snapshot,
  selectedChatId: chat.chatId,
  loading: false,
  error: "",
  connectionLabel: "Connected",
  theme: "dark",
  sidebarDefaultOpen: false,
  onRefresh: () => undefined,
  onSelectChat: () => undefined,
  onOpenChat: () => undefined,
  onAction: () => undefined,
  onTheme: () => undefined,
  onSidebarDefault: () => undefined,
};

test("the Automations page renders workflows, inputs, last run and its actions", () => {
  const html = renderToStaticMarkup(createElement(AutomationsPanel, props));
  assert.match(html, /Daily prices/);
  assert.match(html, /Reads three shops/);
  assert.match(html, /query/);
  assert.match(html, /ok ·/);
  assert.match(html, />Run</);
  assert.match(html, />Export</);
  assert.match(html, /Exported to \/tmp\/x\.json/);
});

test("the Site sessions page lists sessions and offers clear, switch and a logged-out check", () => {
  const html = renderToStaticMarkup(
    createElement(SiteSessionsPanel, { ...props, section: "sessions" }),
  );
  assert.match(html, /shop\.example/);
  assert.match(html, /Stored/);
  assert.match(html, /test@example\.com/);
  assert.match(html, /Clear session/);
  assert.match(html, /Switch account/);
  assert.match(html, /Test logged out/);
});

test("the Sites page renders recipes, health, the stored session and its actions", () => {
  const html = renderToStaticMarkup(createElement(SitesPanel, { ...props, section: "sites" }));
  assert.match(html, /shop\.example/);
  assert.match(html, /12 operations/);
  assert.match(html, /search/);
  assert.match(html, /ok/);
  assert.match(html, /Stored/);
  assert.match(html, /test@example\.com/);
  assert.match(html, />Clear session</);
  assert.match(html, />Switch account</);
  assert.match(html, /Export pack/);
});
