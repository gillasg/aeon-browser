import { TEACH_SITE, teachSiteInWorker } from "../teach-site.js";
import { chatUrl, findExistingChat } from "../native-worker-tabs.js";
import { sidePanelSelectionKey } from "../sidebar-selection.js";
import { isNeedsKey } from "./orb-control.js";
import { jumpToRunTab, runTabs } from "./orb-run-tabs.js";
import { CURSOR_LOCAL, isGraftTabPage, isCursorPage, summonUpdate } from "./orb-graft-pages.js";
import { CURSOR_MARK, CURSOR_TOKEN_CSS } from "@browserkit/engine/cursor-mark";
import { paintCursor } from "graft:cursor-paint";
import {
  CURSOR_INSTALL,
  CURSOR_TRANSCRIPT,
  ORB_BUBBLE_STATE,
  ORB_COMMAND,
  ORB_DISMISS,
  ORB_OFF,
  ORB_ON_KEY,
  ORB_JUMP_TAB,
  ORB_RESTORE,
  ORB_RUN_TABS,
  ORB_TO_PANEL,
  nonceKey,
  type OrbToggle,
  type OrbVerify,
} from "./orb-messages.js";

// The shortcut (a rebindable chrome.commands entry, Alt+Shift+Space by default: ⌥⇧Space on
// macOS) lives in the service worker and opens the box keyboard-centred. It starts and closes the cursor on web pages and on
// Graft's own tabs (Home, a chat tab); pages Chrome keeps extensions out of (chrome://, the Web
// Store, the PDF viewer) get the side panel instead. The worker also keeps
// the toolbar badge: how many runs need the user, else how many finished results are unread.
// The orb is a pet: once summoned it is on every web page (its box open where it was summoned,
// folded elsewhere) and comes back after every navigation and reload, until the shortcut, or a
// move to the side panel or a tab, dismisses it everywhere.

export function installOrb(): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === ORB_COMMAND) summon(tab);
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) =>
    onOrbMessage(request, sender, sendResponse),
  );
  chrome.storage.session.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((key) => isNeedsKey(key) || key.startsWith(UNREAD_PREFIX)))
      void updateBadge();
  });
  void updateBadge();
}

const UNREAD_PREFIX = "piper-unread-";

function onOrbMessage(
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (sender.id !== chrome.runtime.id) return undefined;
  const kind = (request as { kind?: unknown } | null)?.kind;
  if (kind === ORB_RESTORE) return replyRestore(sender.tab?.id, sendResponse);
  if (kind === ORB_OFF) return stopOrb();
  if (kind === CURSOR_TRANSCRIPT) return openTabTranscript(sender.tab);
  if (kind === ORB_TO_PANEL) return toPanel(sender.tab, request, sendResponse);
  if (kind === CURSOR_INSTALL) return installFrom(sender.tab, request);
  if (kind === TEACH_SITE) return teachFromManage(request, sendResponse);
  if (RUN_TAB_KINDS.has(kind)) return runTabRequest(String(kind), request, sender, sendResponse);
  if (kind !== "graft.orb.verify") return undefined;
  void verify(request as Partial<OrbVerify>, sender).then(sendResponse, () =>
    sendResponse({ ok: false }),
  );
  return true;
}

const RUN_TAB_KINDS: ReadonlySet<unknown> = new Set([ORB_RUN_TABS, ORB_JUMP_TAB]);

function runTabRequest(
  kind: string,
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): true {
  const { chatId, tabId } = request as { chatId?: unknown; tabId?: unknown };
  const work =
    kind === ORB_RUN_TABS
      ? typeof chatId === "string" && chatId
        ? runTabs(chatId, sender.tab?.id)
        : Promise.resolve([])
      : typeof tabId === "number"
        ? jumpToRunTab(tabId)
        : Promise.resolve(false);
  void work.then(sendResponse, () => sendResponse(kind === ORB_RUN_TABS ? [] : false));
  return true;
}

function replyRestore(tabId: number | undefined, sendResponse: (response?: unknown) => void): true {
  void restore(tabId).then(sendResponse, () => sendResponse(null));
  return true;
}

function stopOrb(): undefined {
  void setOn(false);
  return undefined;
}

function openTabTranscript(tab: chrome.tabs.Tab | undefined): undefined {
  if (tab) openTranscript(tab);
  return undefined;
}

/** The ask box's ⌘↵ and Open in panel: the side panel beside this tab, on the given chat. */
function toPanel(
  tab: chrome.tabs.Tab | undefined,
  request: unknown,
  sendResponse: (response?: unknown) => void,
): true | undefined {
  if (tab?.id === undefined) return undefined;
  // Must run before any await: opening the side panel needs the click's user gesture.
  const opened = chrome.sidePanel.open({ tabId: tab.id });
  const chatId = (request as { chatId?: unknown }).chatId;
  if (typeof chatId === "string" && chatId)
    void chrome.storage.session
      .set({ [sidePanelSelectionKey(tab.windowId)]: chatId })
      .catch(() => undefined);
  void opened.then(
    () => sendResponse({ ok: true }),
    () => sendResponse({ ok: false }),
  );
  return true;
}

function installFrom(tab: chrome.tabs.Tab | undefined, request: unknown): undefined {
  if (tab?.id === undefined) return undefined;
  const point = request as { x?: unknown; y?: unknown };
  const x = Number(point.x);
  const y = Number(point.y);
  if (isGraftTabPage(tab.url, chrome.runtime.getURL(""))) void drawOnGraftPage(tab.id, x, y);
  else void installSharedCursor(tab.id, x, y);
  return undefined;
}

/** chrome.scripting cannot reach Graft's own pages: they draw the cursor themselves. */
async function drawOnGraftPage(tabId: number, x: number, y: number): Promise<void> {
  const message = {
    kind: CURSOR_LOCAL,
    update: summonUpdate(x, y),
    css: CURSOR_TOKEN_CSS,
    mark: CURSOR_MARK,
  };
  await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
}

async function installSharedCursor(tabId: number, x: number, y: number): Promise<void> {
  // The painter runs from the worker's own function in the extension's isolated world: no page
  // listener, no page global and no page-visible expando, so a page can neither paint Graft's
  // cursor, read its state, nor fingerprint the profile.
  await chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      world: "ISOLATED",
      func: paintCursor,
      args: [summonUpdate(x, y), CURSOR_TOKEN_CSS, CURSOR_MARK],
    })
    .catch(() => undefined);
}

async function updateBadge(): Promise<void> {
  const values = await chrome.storage.session.get(null);
  const keys = Object.keys(values);
  const needs = keys.filter(isNeedsKey).length;
  const unread = keys.filter((key) => key.startsWith(UNREAD_PREFIX)).length;
  const count = needs || unread;
  await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: needs ? "#f5a623" : "#000000" });
  await chrome.action.setTitle({
    title: needs
      ? `Graft · ${needs} need${needs === 1 ? "s" : ""} you`
      : unread
        ? `Graft · ${unread} new result${unread === 1 ? "" : "s"}`
        : "Open Graft Chat",
  });
}

function summon(tab: chrome.tabs.Tab | undefined): void {
  if (tab?.id === undefined) return;
  if (!isCursorPage(tab.url, chrome.runtime.getURL(""))) {
    // Must run before any await: opening the side panel needs the shortcut's user gesture.
    if (tab.windowId !== undefined)
      void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    return;
  }
  void toggle(tab.id);
}

// The shortcut opens the box whenever it is not showing in this tab (after Esc, a submit that
// folded it, a reload) and closes the cursor only when the box is showing. The tab's content
// script is the source of truth, never a remembered flag.
async function toggle(tabId: number): Promise<void> {
  if ((await isOn()) && (await bubbleOpen(tabId))) return setOn(false);
  await setOn(true);
  await present(tabId, true, true);
  // Every other page gets the folded orb; frozen or unloaded tabs ask when they wake.
  for (const tab of await cursorTabs())
    if (tab.id !== undefined && tab.id !== tabId && !tab.discarded)
      void present(tab.id, false).catch(() => undefined);
}

async function bubbleOpen(tabId: number): Promise<boolean> {
  const reply: unknown = await chrome.tabs
    .sendMessage(tabId, { kind: ORB_BUBBLE_STATE }, { frameId: 0 })
    .catch(() => undefined);
  return (reply as { open?: unknown } | undefined)?.open === true;
}

/** Web pages and Graft's own tabs. */
async function cursorTabs(): Promise<chrome.tabs.Tab[]> {
  const base = chrome.runtime.getURL("");
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  return tabs.filter((tab) => isCursorPage(tab.url, base));
}

async function isOn(): Promise<boolean> {
  return (await chrome.storage.session.get(ORB_ON_KEY))[ORB_ON_KEY] === true;
}

async function setOn(on: boolean): Promise<void> {
  await chrome.storage.session.set({ [ORB_ON_KEY]: on });
  if (on) return;
  for (const tab of await cursorTabs())
    if (tab.id !== undefined)
      void chrome.tabs
        .sendMessage(tab.id, { kind: ORB_DISMISS }, { frameId: 0 })
        .catch(() => undefined);
}

/**
 * The cursor's ☰: this tab's chat in the side panel beside it (the cursor never shows the
 * transcript itself), showing the chat this tab's cursor started; for a run started elsewhere the
 * side panel opens on the chat it already shows. Without the side panel (Chrome refused it), the
 * chat opens in a tab.
 */
function openTranscript(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  // Must run before any await: opening the side panel needs the click's user gesture.
  const opened = chrome.sidePanel.open({ tabId });
  void chatForTab(tabId).then(async (chatId) => {
    if (!chatId) return;
    await chrome.storage.session
      .set({ [sidePanelSelectionKey(tab.windowId)]: chatId })
      .catch(() => undefined);
    await opened.catch(async () => {
      const existing = await findExistingChat(chatId);
      if (existing?.id !== undefined) await chrome.tabs.update(existing.id, { active: true });
      else
        await chrome.tabs.create({
          url: chatUrl(chatId),
          windowId: tab.windowId,
          index: tab.index + 1,
        });
    });
  });
}

async function chatForTab(tabId: number): Promise<string | undefined> {
  const key = "graft-orb-chat:" + tabId;
  const values = (await chrome.storage.session.get(key).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const stored = values[key];
  return typeof stored === "string" && stored ? stored : undefined;
}

async function nonceFor(tabId: number): Promise<string> {
  const nonce = crypto.randomUUID();
  await chrome.storage.session.set({ [nonceKey(nonce)]: tabId });
  // A nonce frames orb.html once; an unused one expires.
  setTimeout(() => void chrome.storage.session.remove(nonceKey(nonce)), 30_000);
  return nonce;
}

/** A page that loaded (or woke) while the orb is on asks for it: a fresh nonce for that tab. */
async function restore(tabId: number | undefined): Promise<OrbToggle | null> {
  if (tabId === undefined || !(await isOn())) return null;
  return { kind: "graft.orb.toggle", tabId, nonce: await nonceFor(tabId), open: false };
}

/**
 * A chat asked the user something (ask_user): the orb opens on the tab they are looking at,
 * showing that chat, so the question reaches them wherever they are. Pages Chrome keeps
 * extensions out of get the side panel's badge instead.
 */
export async function presentAsk(chatId: string): Promise<void> {
  const [tab] = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => [] as chrome.tabs.Tab[]);
  if (tab?.id === undefined || !isCursorPage(tab.url, chrome.runtime.getURL(""))) return;
  await chrome.storage.session.set({ ["graft-orb-chat:" + tab.id]: chatId });
  await present(tab.id, true).catch(() => undefined);
}

/** Manage → Sites → Teach Graft: open the site, start Teach, and open the cursor there. */
function teachFromManage(
  request: unknown,
  sendResponse: (response?: unknown) => void,
): true | undefined {
  const host = (request as { host?: unknown } | null)?.host;
  if (typeof host !== "string") return undefined;
  void teachSiteInWorker(host, async (tabId) => {
    await setOn(true);
    await present(tabId, true);
  }).then(
    () => sendResponse({ ok: true }),
    (error: unknown) => {
      console.warn("Graft: Teach Graft failed to start", error);
      sendResponse({ ok: false, error: String(error) });
    },
  );
  return true;
}

async function present(tabId: number, open: boolean, keyboard = false): Promise<void> {
  const message: OrbToggle = {
    kind: "graft.orb.toggle",
    tabId,
    nonce: await nonceFor(tabId),
    open,
    ...(keyboard ? { keyboard } : {}),
  };
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // Tabs opened before Graft loaded have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["orb-content.js"] });
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  }
}

async function verify(
  message: Partial<OrbVerify>,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  if (typeof message.nonce !== "string" || !isOrbFrameUrl(sender.url)) return { ok: false };
  const key = nonceKey(message.nonce);
  const stored = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  return { ok: stored === message.tabId && sender.tab?.id === message.tabId };
}

/**
 * orb.html, as the content script frames it: on web pages through the dynamic URL Chrome gives
 * web-accessible resources, on Graft's own pages from the extension's fixed origin.
 */
function isOrbFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(chrome.runtime.getURL("orb.html"))) return true;
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/orb.html`);
}
