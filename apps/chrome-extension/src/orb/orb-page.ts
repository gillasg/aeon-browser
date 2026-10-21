import type { PiEntryDto, PiSessionEventDto } from "@aeon/protocol";
import { openExtensionChat } from "../ui-connection.js";
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
import { renderView, type OrbViewModel } from "./orb-view.js";
import { WATCH_EVERY_MINUTES, routineEditorUrl, watchPlan, watchRoutine } from "./orb-watch.js";

// orb.html: the bubble. Framed by the content script; talks to the daemon and drives the overlay.

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const root = document.getElementById("root") as HTMLElement;
const model: OrbViewModel = {
  host: "",
  prompt: "",
  run: undefined,
  notice: "",
  busy: false,
  watch: { state: "idle", note: "" },
};
let lastVisual = "";
let sentActions = 0;

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
  new ResizeObserver(() => reportSize()).observe(root);
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") toContent({ kind: "aeon.orb.hide", keepRunning: true });
  });
  chrome.runtime.onMessage.addListener((message: { kind?: string; tabId?: number }) => {
    if (message?.kind === "aeon.orb.shown" && message.tabId === tabId) focusPrompt();
  });
  toContent({ kind: "aeon.orb.visual", state: "listening", label: "Listening" });
  focusPrompt();
  await session.connect().catch((error: unknown) => notice(messageOf(error)));
}

async function submit(text: string): Promise<void> {
  model.prompt = text;
  model.busy = true;
  model.run = initialRun();
  model.watch = { state: "idle", note: "" };
  sentActions = 0;
  sync();
  try {
    await session.start(text);
  } catch (error) {
    model.run = { ...initialRun(), status: "error", error: messageOf(error) };
    sync();
  } finally {
    model.busy = false;
  }
}

function onSnapshot(entries: readonly PiEntryDto[], runState: string): void {
  for (const entry of entries) onEvent({ kind: "entry-added", entry }, false);
  onEvent({ kind: "run-state", state: runState as "idle" }, true);
}

function onEvent(event: PiSessionEventDto, update = true): void {
  if (!model.run) return;
  const next = applyEvent(model.run, event, Date.now());
  if (next === model.run) return;
  model.run = next;
  if (update) sync();
}

/** Pushes the run to the overlay (swarm state, cursor, spotlight) and redraws the bubble. */
function sync(): void {
  const run = model.run;
  if (run) {
    visual(visualState(run), run.label);
    sendNewActions(run.actions);
    if (run.status === "needs")
      toContent({ kind: "aeon.orb.spotlight", box: spotlightBox(run.actions, tabId) ?? null });
  }
  render();
}

function sendNewActions(actions: readonly OrbAction[]): void {
  if (actions.length <= sentActions) return;
  const steps = cursorSteps(actions.slice(sentActions), tabId);
  sentActions = actions.length;
  if (steps.length) toContent({ kind: "aeon.orb.cursor", steps });
}

function visualState(run: OrbRun): OrbVisualState {
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
    setWatch("idle", "Review the routine in the new tab and save it to start watching.");
    return;
  }
  setWatch("saving", "Saving the watcher…");
  try {
    await session.createRoutine({ ...routine });
    setWatch(
      "saved",
      `Checking every ${WATCH_EVERY_MINUTES} minutes. You'll get a notification when it changes.`,
    );
  } catch (error) {
    setWatch("idle", "Couldn't save the watcher · " + messageOf(error));
  }
}

function setWatch(state: OrbViewModel["watch"]["state"], note: string): void {
  model.watch = { state, note };
  render();
}

async function again(): Promise<void> {
  if (!model.prompt) return;
  model.run = initialRun();
  model.watch = { state: "idle", note: "" };
  sentActions = 0;
  sync();
  await session.again(model.prompt).catch((error: unknown) => {
    model.run = { ...initialRun(), status: "error", error: messageOf(error) };
    sync();
  });
}

function openChat(): void {
  if (session.chatId) void openExtensionChat(session.chatId).catch(() => undefined);
}

function render(): void {
  const draft = document.getElementById("prompt") as HTMLTextAreaElement | null;
  const kept = draft ? { value: draft.value, focused: document.activeElement === draft } : null;
  renderView(root, model, {
    submit: (text) => void submit(text),
    close: () => toContent({ kind: "aeon.orb.hide", keepRunning: true }),
    stop: () => void session.stop().catch(() => undefined),
    again: () => void again(),
    watch: () => void watch(),
    openChat,
  });
  const next = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (next && kept) {
    next.value = kept.value;
    if (kept.focused) next.focus();
  }
}

function reportSize(): void {
  const box = root.getBoundingClientRect();
  toContent({ kind: "aeon.orb.panel", width: Math.ceil(box.width), height: Math.ceil(box.height) });
}

function toContent(message: OrbToContent): void {
  void chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
}

function focusPrompt(): void {
  (document.getElementById("prompt") as HTMLTextAreaElement | null)?.focus();
}

function notice(text: string): void {
  model.notice = text;
  render();
}

async function tabHost(): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  try {
    return tab?.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
