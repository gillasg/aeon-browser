import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatNavigation } from "../dist/chat-navigation.js";
import { NewTabHome } from "../dist/home-surface.js";

test("a chat page has no chat list: home and new chat, no title bar", () => {
  const html = renderToStaticMarkup(createElement(ChatNavigation, { onNewChat() {} }));
  assert.match(html, /id="chat-home"/);
  assert.match(html, /aria-label="New Chat"/);
  assert.doesNotMatch(html, /sidebar-toggle|Open Chat list/);
  assert.doesNotMatch(html, /<header|Connected|Aeon/);
});

const homeProps = {
  chats: [],
  modelCatalog: null,
  developmentFixture: false,
  catalogOpen: false,
  openChatIds: new Set(),
  catalogResults: [],
  managementSnapshot: null,
  onManagementLoad() {},
};

test("Manage is one sidebar and a page: no landing, no top bar, no composer", () => {
  globalThis.localStorage = { getItem: () => null };
  globalThis.location = { search: "", hash: "" };
  const html = renderToStaticMarkup(createElement(NewTabHome, homeProps));
  assert.match(html, /class="manage-sidebar"/);
  assert.doesNotMatch(html, /home-top-bar|home-core|placeholder="Ask Aeon to do anything"/);
  for (const page of ["Automations", "Sites", "My Details", "Sign-in", "Settings", "Advanced"])
    assert.match(html, new RegExp(`>${page}</button>`));
  assert.match(html, /aria-current="page"[^>]*>Sites</);
  delete globalThis.localStorage;
  delete globalThis.location;
});

test("the side panel's idle canvas is one quiet line, three examples and the composer", () => {
  globalThis.localStorage = { getItem: () => null };
  globalThis.location = { search: "?host=panel", hash: "" };
  const html = renderToStaticMarkup(createElement(NewTabHome, homeProps));
  assert.doesNotMatch(html, /manage-sidebar/);
  assert.match(html, /Do anything on the web/);
  assert.match(html, /placeholder="Ask Aeon to do anything"/);
  assert.match(html, /Fill this form with my details/);
  assert.doesNotMatch(html, /role="dialog"|tour-actions|Turn this site into an API/);
  delete globalThis.localStorage;
  delete globalThis.location;
});
