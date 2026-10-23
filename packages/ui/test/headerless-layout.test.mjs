import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatNavigation } from "../dist/chat-navigation.js";
import { NewTabHome } from "../dist/home-surface.js";

test("headerless navigation offers sidebar without a title bar", () => {
  const html = renderToStaticMarkup(
    createElement(ChatNavigation, {
      sidebarOpen: false,
      resourcesOpen: false,
      onToggleSidebar() {},
      onToggleResources() {},
      onSettings() {},
    }),
  );
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(html, /aria-label="Open Chat list"/);
  assert.doesNotMatch(html, /<header|Connected|Aeon/);
});

test("new tab has no sidebar: a top bar, an empty composer and the dashboard", () => {
  globalThis.localStorage = { getItem: () => null };
  globalThis.location = { search: "" };
  const html = renderToStaticMarkup(
    createElement(NewTabHome, {
      chats: [],
      modelCatalog: null,
      developmentFixture: false,
      catalogOpen: false,
      homeRoutines: [],
      openChatIds: new Set(),
      catalogResults: [],
    }),
  );
  assert.match(html, /class="home-top-bar"/);
  assert.doesNotMatch(html, /home-top-brand|aria-label="Aeon home"/);
  assert.match(html, /class="home-top-nav"/);
  assert.match(html, /placeholder=""/);
  assert.doesNotMatch(html, /id="chat-sidebar"|id="pinned-label"|id="projects-label"/);
  for (const page of ["Chats", "Routines", "Activity"]) assert.match(html, new RegExp(`>${page}<`));
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /Recent chats/);
  assert.match(html, /role="dialog" aria-label="Welcome to Aeon"/);
  delete globalThis.localStorage;
  delete globalThis.location;
});
