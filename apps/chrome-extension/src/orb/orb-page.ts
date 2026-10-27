import { createElement, type ReactNode } from "react";
import type { PiEntryDto, PiSessionEventDto } from "@aeon/protocol";
import { ORB_REDUCE_MOTION_KEY, logApiWrites, mountAeonUi, orbFlag } from "@aeon/ui";
import { openExtensionChat } from "../ui-connection.js";
import { sidePanelSelectionKey } from "../sidebar-selection.js";
import { TabControl, markSeen, setNeeds } from "./orb-control.js";
import type { OrbToContent, OrbVerify, OrbVisualState } from "./orb-messages.js";
import { applyEvent, cursorSteps, initialRun, spotlightBox, type OrbRun } from "./orb-run.js";
import { OrbSession } from "./orb-session.js";
import { playSound } from "./orb-sounds.js";
import { OrbBox, type OrbViewModel } from "./orb-view.js";

// orb.html: the orb's box. Framed by the content script. Starts the chat, then shows it (the same
// chat page the side panel shows) and keeps following its events to drive the swarm.

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const viewId = crypto.randomUUID();
const root = document.getElementById("root") as HTMLElement;
const model: OrbViewModel = {
  host: "",
  chatId: undefined,
  chatUrl: "",
  notice: "",
  busy: false,
  learning: false,
};
const tab = new TabControl(tabId);
let run: OrbRun | undefined;
let userControl = false;
let lastVisual = "";
let lastState = "";
let sentActions = 0;
let update: ((next: ReactNode) => void) | undefined;

const session = new OrbSession(tabId, {
  event: (event) => onEvent(event),
  snapshot: (entries, runState) => onSnapshot(entries, runState),
  closed: () => notice("Reconnecting to Aeon…"),
});

void boot();

async function boot(): Promise<void> {
  const verify: OrbVerify = { kind: "aeon.orb.verify", tabId, nonce: location.hash.slice(1) };
  history.replaceState(null, "", location.pathname + location.search);
  const verified = (await chrome.runtime.sendMessage(verify).catch(() => null)) as {
    ok?: boolean;
  } | null;
  // Only the content script for this tab may show the orb; anything else gets a blank frame.
  if (!Number.isSafeInteger(tabId) || !verified?.ok) return;
  document.body.hidden = false;
  model.host = await tabHost();
  render();
  void loadLearning();
  listen();
  sendPrefs();
  toContent({ kind: "aeon.orb.visual", state: "listening", label: "Listening" });
  focusPrompt();
  void connectSession();
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
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") toContent({ kind: "aeon.orb.hide", keepRunning: true });
  });
  addEventListener("storage", (event) => {
    if (event.key === ORB_REDUCE_MOTION_KEY) sendPrefs();
  });
  addEventListener("pagehide", () => void setNeeds(tabId, false));
  chrome.runtime.onMessage.addListener(
    (message: { kind?: string; tabId?: number; control?: string }) => {
      if (message?.kind === "aeon.orb.shown" && message.tabId === tabId) focusPrompt();
      // The engine says when the user takes this tab over; the swarm rests until it's given back.
      if (message?.kind === "browserkit.control" && message.tabId === tabId) {
        userControl = message.control === "user";
        sync();
      }
    },
  );
}

async function submit(text: string): Promise<void> {
  model.busy = true;
  run = initialRun();
  sentActions = 0;
  sync();
  playSound("start");
  try {
    await session.start(text);
    showChat();
  } catch (error) {
    run = undefined;
    notice(messageOf(error));
  } finally {
    model.busy = false;
    render();
  }
}

function showChat(): void {
  const chatId = session.chatId;
  if (!chatId) return;
  model.chatId = chatId;
  model.chatUrl = `${chrome.runtime.getURL("chat.html")}?chatId=${encodeURIComponent(chatId)}&host=panel`;
  render();
}

function onSnapshot(entries: readonly PiEntryDto[], runState: string): void {
  for (const entry of entries) onEvent({ kind: "entry-added", entry }, false);
  onEvent({ kind: "run-state", state: runState as "idle" }, true);
}

function onEvent(event: PiSessionEventDto, refresh = true): void {
  if (session.chatId) logApiWrites(event, { chatId: session.chatId, task: "" });
  // A follow-up typed in the framed chat starts a new run in the same chat.
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

/** Pushes the run to the overlay: the swarm's state, where the agent acts, what needs the user. */
function sync(): void {
  if (!run) return;
  const state = visualState(run);
  visual(state, run.label);
  sendNewActions(run);
  if (run.status === "needs" && !userControl)
    toContent({ kind: "aeon.orb.spotlight", box: spotlightBox(run.actions, tabId) ?? null });
  changed(state);
}

/** Things that happen once per change of state: sounds, the tab group, the needs count. */
function changed(state: OrbVisualState): void {
  if (state === lastState) return;
  lastState = state;
  void setNeeds(tabId, state === "needs", session.chatId ?? "");
  if (state === "working" || state === "thinking") void tab.hold();
  else void tab.release();
  if (state === "needs") playSound("needs");
  if (state === "done") {
    playSound("done");
    if (session.chatId) void markSeen(session.chatId, viewId);
  }
}

function sendNewActions(current: OrbRun): void {
  if (current.actions.length <= sentActions) return;
  const steps = cursorSteps(current.actions.slice(sentActions), tabId);
  sentActions = current.actions.length;
  if (steps.length && !userControl) toContent({ kind: "aeon.orb.cursor", steps });
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

async function loadLearning(): Promise<void> {
  const learning = (await chrome.runtime
    .sendMessage({ kind: "aeon.learn.get", tabId })
    .catch(() => null)) as { on?: boolean } | null;
  model.learning = learning?.on === true;
  render();
}

async function toggleLearning(): Promise<void> {
  const reply = (await chrome.runtime
    .sendMessage({ kind: "aeon.learn.set", tabId, on: !model.learning })
    .catch(() => null)) as { ok?: boolean; on?: boolean; error?: string } | null;
  if (reply?.ok) model.learning = reply.on === true;
  else notice("Couldn't start learning this site" + (reply?.error ? " · " + reply.error : ""));
  render();
}

/** Hand-off is manual: the chat moves to the side panel beside this page, and the box collapses. */
function toSidePanel(): void {
  const chatId = session.chatId;
  if (!chatId) return;
  // Must run before any await: opening the side panel needs the click's user gesture.
  const opened = chrome.sidePanel.open({ tabId });
  void chrome.tabs
    .get(tabId)
    .then((current) =>
      chrome.storage.session.set({ [sidePanelSelectionKey(current.windowId)]: chatId }),
    )
    .catch(() => undefined);
  void opened.then(
    () => toContent({ kind: "aeon.orb.hide", keepRunning: true }),
    () => toTab(),
  );
}

function toTab(): void {
  const chatId = session.chatId;
  if (!chatId) return;
  void openExtensionChat(chatId).catch(() => undefined);
  toContent({ kind: "aeon.orb.hide", keepRunning: true });
}

function view(): ReactNode {
  return createElement(OrbBox, {
    model: { ...model },
    actions: {
      submit: (text) => void submit(text),
      close: () => toContent({ kind: "aeon.orb.hide", keepRunning: false }),
      toSidePanel,
      toTab,
      toggleLearning: () => void toggleLearning(),
    },
  });
}

function render(): void {
  if (update) update(view());
  else update = mountAeonUi(root, view());
}

function sendPrefs(): void {
  const reduceMotion = orbFlag(ORB_REDUCE_MOTION_KEY);
  document.documentElement.toggleAttribute("data-reduced-motion", reduceMotion);
  toContent({ kind: "aeon.orb.prefs", reduceMotion });
}

function reportSize(): void {
  const box = root.getBoundingClientRect();
  toContent({ kind: "aeon.orb.panel", width: Math.ceil(box.width), height: Math.ceil(box.height) });
}

function toContent(message: OrbToContent): void {
  void chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
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

async function tabHost(): Promise<string> {
  const current = await chrome.tabs.get(tabId).catch(() => undefined);
  try {
    return current?.url ? new URL(current.url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
