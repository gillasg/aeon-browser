import { createElement, type ReactNode } from "react";
import type { PiEntryDto, PiSessionEventDto } from "@aeon/protocol";
import {
  ORB_REDUCE_MOTION_KEY,
  WRONG_FOLLOW_UP,
  attachFooter,
  logApiWrites,
  mountAeonUi,
  orbFlag,
  runCardOf,
  type AnswerOffer,
} from "@aeon/ui";
import { framedInPage } from "../extension-frame.js";
import { openExtensionChat } from "../ui-connection.js";
import { watchChatRunState } from "../chat-run-state.js";
import { sidePanelSelectionKey } from "../sidebar-selection.js";
import { markSeen, setNeeds } from "./orb-control.js";
import {
  CURSOR_STOP,
  ORB_TO_PANEL,
  type OrbToContent,
  type OrbVerify,
  type OrbVisualState,
} from "./orb-messages.js";
import {
  applyEvent,
  boxLine,
  cursorSteps,
  initialRun,
  spotlightBox,
  type BoxLine,
  type OrbRun,
} from "./orb-run.js";
import { OrbSession } from "./orb-session.js";
import { playSound } from "./orb-sounds.js";
import { OrbBox, islandState, type OrbTab, type OrbViewModel } from "./orb-view.js";
import { localOfferAction } from "../offer-actions.js";
import { reportWrongInput } from "../answer-offer.js";
import { openManage } from "../manage-tab.js";
import { installBrowserPreview } from "../chat-browser-preview.js";
import type { OrbLayout, OrbShown } from "./orb-messages.js";
import {
  applySummon,
  askSummon,
  loadLearning,
  loadXray,
  receiptOf,
  removeTarget,
  toggleLearning,
  type SiteUx,
} from "./orb-site-ux.js";

// orb.html: the cursor's ask box. Framed by the content script. Starts the chat (or sends the
// next message in it), folds back to the cursor, and keeps following the chat's events to drive the
// cursor's pill. The transcript is never shown here: ☰ opens it in the side panel. Each tab's
// cursor keeps its own chat. A tab that never had one shows the chat last used
// in the orb, but only until the orb is closed there: opened again, it starts fresh, so a message
// never lands in work running in another tab. The switcher shows another chat; + starts a new one.

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const viewId = crypto.randomUUID();
const root = document.getElementById("root") as HTMLElement;
const model: OrbViewModel = {
  host: "",
  chatId: undefined,
  notice: "",
  ask: "",
  busy: false,
  learning: false,
  chats: [],
  context: [],
  tabChoices: null,
  running: new Set(),
  needs: new Set(),
};
const TAB_CHAT = "aeon-orb-chat:" + tabId;
const LAST_CHAT = "aeon-orb-chat:last";
let run: OrbRun | undefined;
let userControl = false;
let lastVisual = "";
let lastState = "";
let sentActions = 0;
let update: ((next: ReactNode) => void) | undefined;
/** The chat shown came from another tab's orb, not this tab's own. */
let borrowed = false;
let bootedAt = Number.POSITIVE_INFINITY;
/** The last message sent from here, for Retry. */
let lastPrompt = "";
/** `Type / for Teach, Watch, Fill` shows on the first few summons, then never again. */
const HINT_KEY = "aeon-orb-hint-shown";
const HINT_SUMMONS = 3;

const session = new OrbSession(tabId, {
  event: (event) => onEvent(event),
  snapshot: (entries, runState) => onSnapshot(entries, runState),
  closed: () => void reconnectSession(),
});
let reconnecting = false;
/** The receipt's short form stays on the minimised pill this long after a run ends. */
const RECEIPT_PILL_MS = 6000;
let receiptUntil = 0;
let receiptPillShown = false;
const ux: SiteUx = {
  tabId,
  model,
  session,
  render: () => render(),
  notice: (text) => notice(text),
  toContent: (message) => toContent(message),
};

void boot();
// Work in another tab shows its live tile in the box; work on this tab shows none.
installBrowserPreview(() => model.chatId);

async function boot(): Promise<void> {
  // Framed by the content script on an http(s) page. A top-level open, or a frame without the
  // one-time nonce for this tab, stays blank.
  if (!framedInPage()) return;
  const verify: OrbVerify = { kind: "aeon.orb.verify", tabId, nonce: location.hash.slice(1) };
  history.replaceState(null, "", location.pathname + location.search);
  const verified = (await chrome.runtime.sendMessage(verify).catch(() => null)) as {
    ok?: boolean;
  } | null;
  // Only the content script for this tab may show the orb; anything else gets a blank frame.
  if (!Number.isSafeInteger(tabId) || !verified?.ok) return;
  document.body.hidden = false;
  const own = await tabInfo(tabId);
  model.host = own?.host ?? "";
  model.context = own ? [own] : [];
  render();
  void loadLearning(ux);
  void askSummon(ux);
  void countHint();
  listen();
  sendPrefs();
  toContent({ kind: "aeon.orb.visual", state: "listening", label: "Listening" });
  focusPrompt();
  watchChatRunState((state) => {
    model.running = state.running;
    model.needs = state.needs;
    render();
  });
  await connectSession();
  void loadChats();
  void loadXray(ux);
  chrome.storage.session.onChanged.addListener((changes) => {
    const handed = changes[TAB_CHAT]?.newValue;
    if (typeof handed === "string" && handed && handed !== model.chatId)
      void selectChat(handed, false);
    if (`aeon-learn:${tabId}` in changes || `aeon-learned:${tabId}` in changes)
      void loadLearning(ux);
  });
  const remembered = await rememberedChat();
  bootedAt = Date.now();
  if (remembered.chatId && !model.chatId) {
    await selectChat(remembered.chatId, false);
    borrowed = remembered.borrowed;
  }
}

/** This tab's chat, kept across navigations and reloads; a tab that never had one opens the chat
 * last used in the orb anywhere, so switching tabs keeps the same conversation. */
async function rememberedChat(): Promise<{ chatId?: string; borrowed: boolean }> {
  const stored = await chrome.storage.session.get([TAB_CHAT, LAST_CHAT]).catch(() => ({}));
  const values = stored as Record<string, unknown>;
  const own = values[TAB_CHAT];
  if (typeof own === "string") return own ? { chatId: own, borrowed: false } : { borrowed: false };
  const last = values[LAST_CHAT];
  return typeof last === "string" && last ? { chatId: last, borrowed: true } : { borrowed: false };
}

/** Opened again after closing: a chat borrowed from another tab gives way to a fresh one. */
function reopened(message: OrbShown): void {
  applySummon(ux, message.summon);
  void countHint();
  void loadXray(ux);
  // Teach may have started while the box was closed (Manage → Sites → Teach Aeon).
  void loadLearning(ux);
  focusPrompt();
  if (!borrowed || Date.now() - bootedAt < 1500) return;
  borrowed = false;
  void selectChat(undefined);
}

function remember(chatId: string | undefined): void {
  void chrome.storage.session
    .set({ [TAB_CHAT]: chatId ?? "", [LAST_CHAT]: chatId ?? "" })
    .catch(() => undefined);
}

/** Shows another chat in this orb (the switcher), or a blank one to start (+). */
async function selectChat(chatId: string | undefined, store = true): Promise<void> {
  run = undefined;
  borrowed = false;
  sentActions = 0;
  lastVisual = "";
  lastState = "";
  model.chatId = chatId;
  model.tabChoices = null;
  if (store) remember(chatId);
  render();
  if (!chatId) {
    toContent({ kind: "aeon.orb.visual", state: "listening", label: "Listening" });
    focusPrompt();
  }
  try {
    await session.switchTo(chatId);
  } catch (error) {
    notice(messageOf(error));
  }
}

async function loadChats(): Promise<void> {
  model.chats = await session.listChats().catch(() => model.chats);
  render();
}

// The orb opens and stays open across daemon restarts, so one failed attempt must not leave it
// unable to send.
async function connectSession(): Promise<void> {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await session.connect();
      model.notice = "";
      render();
      return;
    } catch (error) {
      if (Date.now() - started > 5_000) notice(messageOf(error));
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, Math.min(500 * 2 ** Math.min(attempt, 3), 5000)),
      );
    }
  }
}

function listen(): void {
  new ResizeObserver(() => reportSize()).observe(root);
  // A click on the cursor focuses the frame without any message; typing must still land in the field.
  addEventListener("focus", () => {
    if (document.activeElement === document.body || !document.activeElement) focusPrompt();
  });
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") toContent({ kind: "aeon.orb.hide", keepRunning: true });
  });
  addEventListener("storage", (event) => {
    if (event.key === ORB_REDUCE_MOTION_KEY) sendPrefs();
  });
  addEventListener("pagehide", () => void setNeeds(tabId, false));
  chrome.runtime.onMessage.addListener(
    (message: { kind?: string; tabId?: number; control?: string }, sender) => {
      if (message?.kind === "aeon.orb.shown" && message.tabId === tabId)
        reopened(message as OrbShown);
      // The cursor's ■ in this tab stops this cursor's chat.
      if (message?.kind === CURSOR_STOP && sender.tab?.id === tabId) void session.stop();
      // The engine says when the user takes this tab over; the swarm rests until it's given back.
      if (message?.kind === "browserkit.control" && message.tabId === tabId) {
        userControl = message.control === "user";
        sync();
      }
    },
  );
}

async function answerOffer(offer: AnswerOffer): Promise<void> {
  try {
    const url = (await chrome.tabs.get(tabId).catch(() => undefined))?.url;
    const local = await localOfferAction(offer, url);
    if (local.handled) {
      notice(local.notice);
      void loadXray(ux);
      return;
    }
  } catch (error) {
    notice(messageOf(error));
    return;
  }
  if (offer.followUp.trim()) void submit(offer.followUp);
}

/** "Wrong": Aeon marks the route as wrong (best effort) and is asked to try again. */
async function answerWrong(): Promise<void> {
  const url = (await chrome.tabs.get(tabId).catch(() => undefined))?.url;
  const input = reportWrongInput(url);
  if (input) void session.reportWrong(input).catch(() => undefined);
  await submit(WRONG_FOLLOW_UP);
}

// Sent, the box stays where it is: compose, then the working pill, then the answer in place. It
// folds to the cursor's pill only when the user dismisses it. A chat this cursor already
// has gets the message as its next turn; otherwise a new chat starts with this tab as context.
async function submit(text: string): Promise<void> {
  lastPrompt = text;
  model.asked = text;
  model.startedAt = Date.now();
  delete model.durationMs;
  model.busy = true;
  model.tabChoices = null;
  borrowed = false;
  run = initialRun();
  sentActions = 0;
  render();
  sync();
  playSound("start");
  clearPrompt();
  try {
    if (model.chatId && session.chatId === model.chatId) await session.again(text);
    else
      await session.start(
        text,
        model.context.map((tab) => tab.tabId),
        (chatId) => {
          model.chatId = chatId;
          remember(chatId);
          render();
        },
      );
  } catch (error) {
    run = undefined;
    notice(messageOf(error));
    visual("error", "Couldn't send: " + messageOf(error));
  } finally {
    model.busy = false;
    // The target went with this message; the next one starts without it.
    if (model.target) removeTarget(ux);
    render();
  }
}

/** A snapshot replaces the run, so the orb shows what the chat page shows; steps it already
 * played do not move the cursor again. */
function onSnapshot(entries: readonly PiEntryDto[], runState: string): void {
  run = initialRun();
  for (const entry of entries) onEvent({ kind: "entry-added", entry }, false);
  onEvent({ kind: "run-state", state: runState as "idle" }, false);
  sentActions = run.actions.length;
  // A replayed run ended earlier: its receipt does not take over the pill now.
  receiptPillShown = true;
  sync();
}

/** The link to the daemon dropped: connect again until it answers, then take a fresh snapshot. */
async function reconnectSession(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  notice("Reconnecting to Aeon…");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await session.reconnect();
      break;
    } catch {
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, Math.min(500 * 2 ** Math.min(attempt, 3), 5000)),
      );
    }
  }
  reconnecting = false;
  notice("");
}

function onEvent(event: PiSessionEventDto, refresh = true): void {
  if (session.chatId) logApiWrites(event, { chatId: session.chatId, task: "" });
  const card = runCardOf(event);
  if (card) {
    if (!run) return;
    run = attachFooter(run, card);
    if (refresh) sync();
    return;
  }
  // A follow-up (from the box or the side panel) starts a new run in the same chat.
  if (!run || (event.kind === "run-state" && event.state === "running-unconfirmed" && done(run))) {
    run = initialRun();
    sentActions = 0;
  }
  const next = applyEvent(run, event, Date.now());
  if (next === run) return;
  run = next;
  if (refresh) sync();
}

function done(current: OrbRun): boolean {
  return current.status === "done" || current.status === "error";
}

function sameFooter(current: OrbViewModel["footer"], next: OrbViewModel["footer"]): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function sameBoxLine(current: BoxLine | undefined, next: BoxLine | null): boolean {
  if (!current && !next) return true;
  if (!current || !next) return false;
  return current.text === next.text && current.more === next.more && current.title === next.title;
}

/** The box's ask, line and footer follow the run. */
function syncBox(current: OrbRun): void {
  const ask = current.status === "needs" ? current.label : "";
  const line = boxLine(current);
  const same =
    ask === model.ask && sameBoxLine(model.line, line) && sameFooter(model.footer, current.footer);
  if (same) return;
  model.ask = ask;
  if (line) model.line = line;
  else delete model.line;
  if (current.footer) model.footer = current.footer;
  else delete model.footer;
  if (current.status === "done" && model.startedAt !== undefined && model.durationMs === undefined)
    model.durationMs = Date.now() - model.startedAt;
  render();
  if (ask) focusPrompt();
}

/** Pushes the run to the overlay: the swarm's state, where the agent acts, what needs the user. */
function sync(): void {
  if (!run) return;
  const state = visualState(run);
  syncBox(run);
  if (state === "done" && !receiptPillShown && receiptOf(run.footer)) showReceiptOnPill();
  visual(state, pillLabel(state, run.label));
  sendNewActions(run);
  if (run.status === "needs" && !userControl)
    toContent({ kind: "aeon.orb.spotlight", box: spotlightBox(run.actions, tabId) ?? null });
  changed(state);
}

/** Things that happen once per change of state: sounds and the needs count. The user's own tab
 * never joins a tab group; the engine's glow shows the agent is working in it. */
function changed(state: OrbVisualState): void {
  if (state === lastState) return;
  lastState = state;
  if (state !== "done") receiptPillShown = false;
  void setNeeds(tabId, state === "needs", session.chatId ?? "");
  if (state === "needs") playSound("needs");
  if (state === "done") {
    playSound("done");
    if (session.chatId) void markSeen(session.chatId, viewId);
  }
}

function sendNewActions(current: OrbRun): void {
  if (current.actions.length <= sentActions) return;
  const fresh = current.actions.slice(sentActions);
  const steps = cursorSteps(fresh, tabId);
  sentActions = current.actions.length;
  if (steps.length && !userControl) toContent({ kind: "aeon.orb.cursor", steps });
}

/** For 6 s after a run ends the minimised pill says its receipt (`0.8 s · via skill`). */
function showReceiptOnPill(): void {
  const short = receiptOf(run?.footer)?.short;
  if (!short) return;
  receiptPillShown = true;
  receiptUntil = Date.now() + RECEIPT_PILL_MS;
  globalThis.setTimeout(() => {
    receiptUntil = 0;
    sync();
  }, RECEIPT_PILL_MS);
}

function pillLabel(state: OrbVisualState, label: string): string {
  const short = receiptOf(run?.footer)?.short;
  return state === "done" && short && Date.now() < receiptUntil ? short : label;
}

function visualState(current: OrbRun): OrbVisualState {
  if (userControl) return "paused";
  return current.status === "idle" ? "thinking" : current.status;
}

function visual(state: OrbVisualState, label: string): void {
  const key = state + "|" + label;
  if (key === lastVisual) return;
  lastVisual = key;
  toContent({ kind: "aeon.orb.visual", state, label });
}

/**
 * Hand-off is manual: the chat moves to the side panel beside this page, and the box collapses.
 * The worker opens the panel (as for the cursor's ☰): sidePanel.open called from this framed
 * page does not reliably carry the click's gesture. Without the panel, the chat opens in a tab.
 */
function openPanel(chatId: string | undefined): Promise<boolean> {
  return chrome.runtime
    .sendMessage({ kind: ORB_TO_PANEL, chatId })
    .then((reply: unknown) => (reply as { ok?: unknown } | undefined)?.ok === true)
    .catch(() => false);
}

function toSidePanel(): void {
  const chatId = session.chatId;
  if (!chatId) return;
  void openPanel(chatId).then((ok) =>
    ok ? toContent({ kind: "aeon.orb.hide", keepRunning: true }) : toTab(),
  );
}

/**
 * ⌘↵: the panel opens beside this page on this chat (the keypress is the user gesture
 * sidePanel.open needs), and a draft goes there as the next message. Never automatic.
 */
function promote(text?: string): void {
  const opened = openPanel(session.chatId);
  void opened.then((ok) => {
    if (ok) toContent({ kind: "aeon.orb.hide", keepRunning: true });
    else if (!text) toTab();
  });
  if (text)
    void submit(text).then(async () => {
      const chatId = session.chatId;
      if (!chatId || !(await opened)) return;
      const windowId = (await chrome.tabs.get(tabId).catch(() => undefined))?.windowId;
      if (windowId !== undefined)
        await chrome.storage.session
          .set({ [sidePanelSelectionKey(windowId)]: chatId })
          .catch(() => undefined);
    });
}

function retry(): void {
  if (lastPrompt && !model.busy) void submit(lastPrompt);
}

function copyAnswer(): void {
  const text = (run?.answer ?? model.line?.text ?? "").trim();
  if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
}

async function countHint(): Promise<void> {
  const stored = (await chrome.storage.local.get(HINT_KEY).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const shown = Number(stored[HINT_KEY]) || 0;
  model.hint = shown < HINT_SUMMONS;
  render();
  if (model.hint) await chrome.storage.local.set({ [HINT_KEY]: shown + 1 }).catch(() => undefined);
}

function dismissHint(): void {
  model.hint = false;
  render();
  void chrome.storage.local.set({ [HINT_KEY]: HINT_SUMMONS }).catch(() => undefined);
}

function toTab(): void {
  const chatId = session.chatId;
  if (!chatId) return;
  void openExtensionChat(chatId).catch(() => undefined);
  toContent({ kind: "aeon.orb.hide", keepRunning: true });
}

/** Open tabs that can be pages for the message (the + list). */
async function pickTabs(): Promise<void> {
  if (model.tabChoices) {
    model.tabChoices = null;
    return render();
  }
  const tabs = await chrome.tabs.query({}).catch(() => []);
  model.tabChoices = tabs.flatMap((tab) => {
    const info = tab.id === undefined ? undefined : describeTab(tab);
    return info ? [info] : [];
  });
  render();
}

async function addContext(id: number): Promise<void> {
  const info = await tabInfo(id);
  if (info && !model.context.some((tab) => tab.tabId === id))
    model.context = [...model.context, info];
  model.tabChoices = null;
  render();
  focusPrompt();
}

function removeContext(id: number): void {
  model.context = model.context.filter((tab) => tab.tabId !== id);
  render();
  focusPrompt();
}

function view(): ReactNode {
  return createElement(OrbBox, {
    model: { ...model },
    actions: {
      submit: (text) => void submit(text),
      minimize: () => toContent({ kind: "aeon.orb.hide", keepRunning: true }),
      selectChat: (chatId) => void selectChat(chatId),
      newChat: () => void selectChat(undefined),
      loadChats: () => void loadChats(),
      toSidePanel,
      answerOffer: (offer) => void answerOffer(offer),
      answerWrong: () => void answerWrong(),
      retry,
      promote,
      copyAnswer,
      dismissHint,
      toggleLearning: () => void toggleLearning(ux),
      openManage: (route) => void openManage(route).catch(() => undefined),
      removeTarget: () => {
        removeTarget(ux);
        focusPrompt();
      },
      hoverTarget: (on) => toContent({ kind: "aeon.orb.target", action: on ? "hover" : "unhover" }),
      pickTabs: () => void pickTabs(),
      addContext: (id) => void addContext(id),
      removeContext,
    },
  });
}

let lastLayout = "";
function render(): void {
  if (update) update(view());
  else update = mountAeonUi(root, view());
  // A width change alone may not change the root's height, so say the new layout at once.
  const layout = (model.learning ? "teach" : "") + islandState(model);
  if (layout !== lastLayout) {
    lastLayout = layout;
    requestAnimationFrame(reportSize);
  }
}

function sendPrefs(): void {
  const reduceMotion = orbFlag(ORB_REDUCE_MOTION_KEY);
  document.documentElement.toggleAttribute("data-reduced-motion", reduceMotion);
  toContent({ kind: "aeon.orb.prefs", reduceMotion });
}

function reportSize(): void {
  const box = root.getBoundingClientRect();
  const state = islandState(model);
  const wide = state === "answer" || state === "error";
  const layout: OrbLayout = model.learning ? "teach" : wide ? "answer" : "compose";
  toContent({
    kind: "aeon.orb.panel",
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
    layout,
  });
}

function toContent(message: OrbToContent): void {
  void chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
}

function clearPrompt(): void {
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (!prompt) return;
  prompt.value = "";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
}

function focusPrompt(): void {
  requestAnimationFrame(() =>
    (document.getElementById("prompt") as HTMLTextAreaElement | null)?.focus(),
  );
}

function notice(text: string): void {
  model.notice = text;
  render();
}

async function tabInfo(id: number): Promise<OrbTab | undefined> {
  const tab = await chrome.tabs.get(id).catch(() => undefined);
  return tab ? describeTab(tab) : undefined;
}

/** Only web pages can be read as context. */
function describeTab(tab: chrome.tabs.Tab): OrbTab | undefined {
  if (tab.id === undefined || !tab.url || !/^https?:/.test(tab.url)) return undefined;
  let host: string;
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
  return {
    tabId: tab.id,
    title: tab.title ?? host,
    host,
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
