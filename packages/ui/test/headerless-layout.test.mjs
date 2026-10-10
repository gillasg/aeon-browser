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

test("new tab starts with a closed sidebar and an empty composer", () => {
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
  assert.match(html, /data-sidebar-collapsed="true"/);
  assert.match(html, /placeholder=""/);
  assert.doesNotMatch(html, /id="pinned-label"|id="projects-label"/);
  assert.match(html, /MCPs \/ CLIs/);
  assert.match(html, /Aeon|aeon-wordmark/);
  delete globalThis.localStorage;
  delete globalThis.location;
});
