import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatNavigation } from "../dist/chat-navigation.js";
import { NewTabHome } from "../dist/home-surface.js";

test("headerless navigation offers sidebar and settings without a title bar", () => {
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
  assert.match(html, /aria-label="Settings"/);
  assert.doesNotMatch(html, /<header|Connected|Pippin/);
});

test("new tab starts with a closed sidebar and an unbranded new chat prompt", () => {
  const html = renderToStaticMarkup(
    createElement(NewTabHome, {
      chats: [],
      modelCatalog: null,
      developmentFixture: false,
      catalogOpen: false,
    }),
  );
  assert.match(html, /data-sidebar-collapsed="true"/);
  assert.match(html, /placeholder="What would you like to work on\?"/);
  assert.doesNotMatch(html, /id="pinned-label"|id="projects-label"/);
  assert.match(html, /MCPs \/ CLIs/);
  assert.doesNotMatch(html, /class="home-mark"|class="brand-mark"|class="home-sidebar-name"/);
});
