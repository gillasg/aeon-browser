import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const ui = fileURLToPath(new URL("../../../packages/ui/src/", import.meta.url));

test("New Tab, Chat and side panel each mount one shared UI root", async () => {
  const hosts = [
    { page: "chat-page.ts", html: "chat.html", component: "ChatSurface" },
    { page: "home-page.ts", html: "home.html", component: "NewTabHome" },
    { page: "sidepanel-page.ts", html: "sidepanel.html", component: "SidePanel" },
  ];
  for (const host of hosts) {
    const [page, html] = await Promise.all([
      readFile(join(app, "src", host.page), "utf8"),
      readFile(join(app, host.html), "utf8"),
    ]);
    assert.match(page, /from "@pippin\/ui"/, `${host.page} must consume the shared UI package`);
    assert.match(page, new RegExp(`createElement\\(${host.component}\\b`));
    assert.equal(
      (page.match(/mountPippinUi\(/g) ?? []).length,
      1,
      `${host.page} must own one mount call`,
    );
    assert.equal(
      (html.match(/id="root"/g) ?? []).length,
      1,
      `${host.html} must declare one React host`,
    );
  }
});

test("Chat and composer presentation are shared, including side-panel iframe route", async () => {
  const [chatSurface, sidePanel, page] = await Promise.all([
    readFile(join(ui, "chat-surface.tsx"), "utf8"),
    readFile(join(ui, "side-panel.tsx"), "utf8"),
    readFile(join(app, "src", "sidepanel-page.ts"), "utf8"),
  ]);
  assert.match(chatSurface, /<ChatTranscript\b/);
  assert.match(chatSurface, /<ChatComposer\b/);
  assert.match(chatSurface, /<ChatSidebar\b/);
  assert.match(sidePanel, /<iframe\b/);
  assert.match(page, /host=panel/);
});

test("context-menu source follows the same Chat into the panel and remains removable", async () => {
  const [manifest, menu, storage, panel, chat, composer, submit, chip] = await Promise.all([
    readFile(join(app, "manifest.native.json"), "utf8"),
    readFile(join(app, "src", "native-browser-context-menu.ts"), "utf8"),
    readFile(join(app, "src", "browser-context-storage.ts"), "utf8"),
    readFile(join(app, "src", "sidepanel-page.ts"), "utf8"),
    readFile(join(app, "src", "chat-page.ts"), "utf8"),
    readFile(join(app, "src", "chat-composer-controller.ts"), "utf8"),
    readFile(join(app, "src", "chat-composer-submit.ts"), "utf8"),
    readFile(join(ui, "browser-context-view.tsx"), "utf8"),
  ]);
  assert.match(manifest, /"contextMenus"/);
  assert.match(menu, /source\?\.target/);
  assert.match(menu, /selection\.slice\(0, 8000\)/);
  assert.match(menu, /chrome\.sidePanel\.open\(\{ windowId: tab\.windowId \}\)/);
  assert.match(panel, /pendingHandoffs\(windowId\)/);
  assert.match(panel, /saveChatContext\(targetChatId, handoff\)/);
  assert.match(panel, /chat\.html.*chatId=.*selectedChatId.*host=panel/);
  assert.match(storage, /chatContextKey\(chatId\)/);
  assert.match(chat, /subscribeChatContextDraft\(chatId/);
  assert.match(composer, /browserContext,/);
  assert.match(submit, /input\.browserContext \? \{ browserContext: input\.browserContext \}/);
  assert.match(chip, /Remove page context/);
});

test("shared root rejects duplicate mounts and imperative page renderers are gone", async () => {
  const mount = await readFile(join(ui, "mount.tsx"), "utf8");
  assert.match(mount, /WeakMap<Element, Root>/);
  assert.match(mount, /already has a React root/);
  for (const file of [
    "chat-render.ts",
    "chat-sidebar.ts",
    "chat-attachment-controller.ts",
    "home-sidebar-controller.ts",
  ]) {
    await assert.rejects(readFile(join(app, "src", file)), { code: "ENOENT" });
  }
  const entries = await readdir(ui);
  assert.ok(entries.includes("tokens.css"));
});

test("browser capture hooks follow the React home, Chat, and panel controls", async () => {
  const [home, homeStart, chat, composer, panel, panelCapture, panelCss] = await Promise.all([
    readFile(join(ui, "home-surface.tsx"), "utf8"),
    readFile(join(ui, "home-start.tsx"), "utf8"),
    readFile(join(ui, "chat-surface.tsx"), "utf8"),
    readFile(join(ui, "chat-composer.tsx"), "utf8"),
    readFile(join(ui, "side-panel.tsx"), "utf8"),
    readFile(join(app, "..", "..", "scripts", "capture-slice-2-sidepanel.mjs"), "utf8"),
    readFile(join(app, "sidepanel.css"), "utf8"),
  ]);
  assert.match(home, /id="home-connection"/);
  assert.match(homeStart, /id="home-form"/);
  assert.match(homeStart, /id="home-query"/);
  assert.match(chat, /id="connection-state"/);
  assert.match(composer, /id="composer"/);
  assert.match(composer, /id="stop"/);
  assert.match(panel, /id="chat-picker-list"/);
  assert.match(panel, /data-chat-id=\{chat\.chatId\}/);
  assert.match(panelCss, /#root\s*\{[^}]*flex:\s*1/s);
  assert.match(panelCapture, /assertPanelFillsHeight\(layout\)/);
});

test("New Tab is Ask-only and applies its dynamic Pi selection before the first prompt", async () => {
  const [
    homeStart,
    page,
    initialSubmit,
    nativeRequest,
    nativeStage,
    catalogRequest,
    homeManagement,
  ] = await Promise.all([
    readFile(join(ui, "home-start.tsx"), "utf8"),
    readFile(join(app, "src", "home-page.ts"), "utf8"),
    readFile(join(app, "src", "chat-initial-submit.ts"), "utf8"),
    readFile(join(app, "src", "native-extension-message.ts"), "utf8"),
    readFile(join(app, "src", "native-initial-submit.ts"), "utf8"),
    readFile(join(app, "src", "initial-chat-selection.ts"), "utf8"),
    readFile(join(app, "src", "home-management-controller.ts"), "utf8"),
  ]);
  assert.match(homeStart, /placeholder="What would you like to work on\?"/);
  assert.match(homeStart, /<PiModelPicker/);
  assert.match(homeStart, /<PiThinkingPicker/);
  assert.match(homeStart, /models=\{catalog\?\.models/);
  assert.doesNotMatch(homeStart, /home-mode-switch|function ModeSwitch|Search or type a URL/);
  assert.doesNotMatch(page, /chrome\.search\.query|function searchWeb/);
  assert.match(page, /operation: "chat\.model-catalog"/);
  assert.match(homeManagement, /operation: "management\.home"/);
  assert.ok(
    page.indexOf("applyInitialChatSelection(activeClient, chatId") <
      page.indexOf('operation: "chat.submit"'),
  );
  assert.match(catalogRequest, /operation: "chat\.model"/);
  assert.match(catalogRequest, /operation: "chat\.thinking"/);
  assert.match(initialSubmit, /applyInitialChatSelection\(client, chatId/);
  assert.match(nativeRequest, /thinkingLevel: z\.string/);
  assert.match(nativeStage, /model: z\s*\.object/);
  assert.match(nativeStage, /thinkingLevel: z\.string/);
});
