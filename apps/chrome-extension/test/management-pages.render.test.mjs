import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationsPanel, SitesPage, siteEntries, siteSummary } from "@aeon/ui";

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

test("the Sites page lists every site with what Aeon can do, the account and rules", () => {
  const html = renderToStaticMarkup(
    createElement(SitesPage, { ...props, section: "sites", blockedSites: ["bad.example"] }),
  );
  assert.match(html, /shop\.example/);
  assert.match(html, /test@example\.com/);
  assert.match(html, /bad\.example/);
  assert.match(html, /blocked/);
});

test("a site's entry joins its mapped API, routines and block rule", () => {
  const entries = siteEntries(
    snapshot.sites,
    ["bad.example"],
    [{ routineId: "r", sites: ["shop.example"], title: "Price" }],
  );
  assert.deepEqual(
    entries.map((entry) => entry.host),
    ["bad.example", "shop.example"],
  );
  assert.equal(entries[1].routines.length, 1);
  assert.match(siteSummary(entries[1]), /1 watching/);
  assert.equal(siteSummary(entries[0]), "blocked");
});
