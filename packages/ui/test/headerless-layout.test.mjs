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
  // A quiet home: the core and the ask box, with no empty sections under them.
  assert.match(html, /class="home-core" data-mode="idle"/);
  assert.doesNotMatch(html, /Recent|Press Watch/);
  assert.match(html, /role="dialog" aria-label="Welcome to Aeon"/);
  delete globalThis.localStorage;
  delete globalThis.location;
});
