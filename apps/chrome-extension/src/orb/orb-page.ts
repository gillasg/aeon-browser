import { createElement, type ReactNode } from "react";
import type { PiEntryDto, PiSessionEventDto } from "@aeon/protocol";
import { ORB_REDUCE_MOTION_KEY, logApiWrites, mountAeonUi, orbFlag } from "@aeon/ui";
import { openExtensionChat } from "../ui-connection.js";
import { logWrites } from "./orb-activity.js";
import { TabControl, isNeedsKey, markSeen, needsCount, setNeeds } from "./orb-control.js";
import type { OrbToContent, OrbVerify, OrbVisualState } from "./orb-messages.js";
import {
  applyEvent,
  cursorSteps,
  initialRun,
  spotlightBox,
  type OrbAction,
  type OrbRun,
} from "./orb-run.js";
import { OrbSession } from "./orb-session.js";
import { playSound } from "./orb-sounds.js";
import { Island, islandState, type IslandState, type OrbViewModel } from "./orb-view.js";
import { WATCH_EVERY_MINUTES, routineEditorUrl, watchPlan, watchRoutine } from "./orb-watch.js";
import { siteVerbs, type SiteVerb } from "./orb-verbs.js";

// orb.html: the island. Framed by the content script; talks to the daemon and drives the overlay.

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const viewId = crypto.randomUUID();
const root = document.getElementById("root") as HTMLElement;
const model: OrbViewModel = {
  host: "",
  prompt: "",
  run: undefined,
  notice: "",
  busy: false,
  watch: { state: "idle", note: "" },
  paused: false,
  expanded: false,
  needsCount: 0,
  verbs: [],
  learning: false,
};
const tab = new TabControl(tabId);
let lastVisual = "";
let lastState: IslandState = "compose";
let sentActions = 0;
let update: ((next: ReactNode) => void) | undefined;

const session = new OrbSession(tabId, {
  event: (event) => onEvent(event),
  snapshot: (entries, runState) => onSnapshot(entries, runState),
  closed: () => notice("Lost the connection to Aeon."),
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
  void loadSite();
  listen();
  sendPrefs();
  toContent({ kind: "aeon.orb.visual", state: "listening", label: "Listening" });
  focusPrompt();
  void connectSession();
}

// The orb opens and stays open across daemon restarts, so one failed attempt must not leave it
// on "Connecting…" until the window is closed.
async function connectSession(): Promise<void> {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await session.connect();
      model.notice = "";
      render();
      return;
    } catch (error) {
      // After a few seconds, say which link is down instead of leaving "Connecting…".
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
  chrome.runtime.onMessage.addListener((message: { kind?: string; tabId?: number }) => {
    if (message?.kind === "aeon.orb.shown" && message.tabId === tabId) focusPrompt();
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (Object.keys(changes).some(isNeedsKey)) void refreshNeeds();
  });
}

async function submit(text: string): Promise<void> {
  model.prompt = text;
  model.busy = true;
  reset();
  playSound("start");
  try {
    await session.start(text);
  } catch (error) {
    fail(error);
  } finally {
    model.busy = false;
  }
}

function reset(): void {
  model.run = initialRun();
  model.watch = { state: "idle", note: "" };
  model.paused = false;
  model.expanded = false;
  sentActions = 0;
  sync();
}

function fail(error: unknown): void {
  model.run = { ...initialRun(), status: "error", error: messageOf(error) };
  sync();
}

function onSnapshot(entries: readonly PiEntryDto[], runState: string): void {
  for (const entry of entries) onEvent({ kind: "entry-added", entry }, false);
  onEvent({ kind: "run-state", state: runState as "idle" }, true);
}

function onEvent(event: PiSessionEventDto, refresh = true): void {
  if (session.chatId) logApiWrites(event, { chatId: session.chatId, task: model.prompt });
  if (!model.run || model.paused) return;
  const next = applyEvent(model.run, event, Date.now());
  if (next === model.run) return;
  model.run = next;
  if (refresh) sync();
}

/** Pushes the run to the overlay (swarm, cursor, spotlight, glow) and redraws the island. */
function sync(): void {
  const run = model.run;
  if (run) {
    visual(visualState(run), model.paused ? "You're driving" : run.label);
    sendNewActions(run.actions);
    if (run.status === "needs" && !model.paused)
      toContent({ kind: "aeon.orb.spotlight", box: spotlightBox(run.actions, tabId) ?? null });
  }
  changed(islandState(model));
  render();
}

/** Things that happen once per change of state: sounds, the tab group, the needs count, the log. */
function changed(state: IslandState): void {
  if (state === lastState) return;
  lastState = state;
  void setNeeds(tabId, state === "needs", session.chatId ?? "");
  if (state === "working") void tab.hold();
  else void tab.release();
  if (state === "needs") playSound("needs");
  if (state === "done" && model.run) {
    playSound("done");
    if (session.chatId) {
      void markSeen(session.chatId, viewId);
      logWrites(model.run, { chatId: session.chatId, host: model.host, task: model.prompt });
    }
  }
}

function sendNewActions(actions: readonly OrbAction[]): void {
  if (actions.length <= sentActions) return;
  const steps = cursorSteps(actions.slice(sentActions), tabId);
  sentActions = actions.length;
  if (steps.length && !model.paused) toContent({ kind: "aeon.orb.cursor", steps });
}

function visualState(run: OrbRun): OrbVisualState {
  if (model.paused) return "paused";
  return run.status === "idle" ? "thinking" : run.status;
}

function visual(state: OrbVisualState, label: string): void {
  const key = state + "|" + label;
  if (key === lastVisual) return;
  lastVisual = key;
  toContent({ kind: "aeon.orb.visual", state, label });
}

/**
 * Watch: makes this task a routine every 15 minutes. A read-only check is saved directly;
 * anything that clicked through the page opens the routine editor, prefilled, to confirm.
 */
async function watch(): Promise<void> {
  const plan = model.run ? watchPlan(model.run) : undefined;
  if (!plan || plan.kind === "none" || !session.chatId || !model.prompt) return;
  const routine = watchRoutine(model.prompt);
  if (plan.kind === "editor") {
    const url = routineEditorUrl(chrome.runtime.getURL("home.html"), session.chatId, routine);
    await chrome.tabs.create({ url, openerTabId: tabId });
    setWatch("idle", "Review the routine in the new tab and save it to start checking.");
    return;
  }
  setWatch("saving", "Saving the routine…");
  try {
    await session.createRoutine({ ...routine });
    setWatch(
      "saved",
      `Checking every ${WATCH_EVERY_MINUTES} minutes. You'll get a notification when it changes.`,
    );
  } catch (error) {
    setWatch("idle", "Couldn't save the routine · " + messageOf(error));
  }
}

function setWatch(state: OrbViewModel["watch"]["state"], note: string): void {
  model.watch = { state, note };
  render();
}

async function again(text = model.prompt): Promise<void> {
  if (!text) return;
  reset();
  playSound("start");
  await session.again(text).catch(fail);
}

/** The user takes the wheel: the run stops and the island waits for Resume. */
function takeOver(): void {
  model.paused = true;
  model.expanded = false;
  toContent({ kind: "aeon.orb.spotlight", box: null });
  void session.stop().catch(() => undefined);
  sync();
}

function resume(): void {
  void again(
    `Continue this task from where the page is now (I changed things myself): ${model.prompt}`,
  );
}

/** What Aeon knows about this site: its learned verbs, and whether this tab is learning. */
async function loadSite(): Promise<void> {
  if (!model.host) return;
  const [operations, learning] = await Promise.all([
    chrome.runtime
      .sendMessage({ kind: "aeon.site.operations", host: model.host })
      .catch(() => []) as Promise<unknown>,
    chrome.runtime.sendMessage({ kind: "aeon.learn.get", tabId }).catch(() => null) as Promise<{
      on?: boolean;
    } | null>,
  ]);
  model.verbs = siteVerbs(model.host, Array.isArray(operations) ? operations : []);
  model.learning = learning?.on === true;
  render();
}

function useVerb(verb: SiteVerb): void {
  if (verb.run) {
    void submit(verb.prompt);
    return;
  }
  const field = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (!field) return;
  field.value = verb.prompt;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

async function toggleLearning(): Promise<void> {
  const reply = (await chrome.runtime
    .sendMessage({ kind: "aeon.learn.set", tabId, on: !model.learning })
    .catch(() => null)) as { ok?: boolean; on?: boolean; error?: string } | null;
  if (reply?.ok) model.learning = reply.on === true;
  else notice("Couldn't start learning this site" + (reply?.error ? " · " + reply.error : ""));
  render();
}

function openChat(): void {
  if (session.chatId) void openExtensionChat(session.chatId).catch(() => undefined);
}

function view(): ReactNode {
  return createElement(Island, {
    model: { ...model },
    actions: {
      submit: (text) => void submit(text),
      close: () => toContent({ kind: "aeon.orb.hide", keepRunning: true }),
      stop: () => void session.stop().catch(() => undefined),
      again: () => void again(),
      watch: () => void watch(),
      openChat,
      takeOver,
      resume,
      useVerb,
      toggleLearning: () => void toggleLearning(),
      toggleDetails: () => {
        model.expanded = !model.expanded;
        render();
      },
    },
  });
}

function render(): void {
  if (update) update(view());
  else update = mountAeonUi(root, view());
}

async function refreshNeeds(): Promise<void> {
  model.needsCount = await needsCount();
  render();
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
