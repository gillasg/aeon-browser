import {
  ORB_DISMISS,
  ORB_OFF,
  ORB_RESTORE,
  isOrbToContent,
  isOrbToggle,
  type OrbShown,
  type OrbToContent,
  type OrbToggle,
} from "./orb-messages.js";
import { startCursorControls } from "./cursor-controls.js";
import { drawLocalCursor, isCursorLocal, pageChatId } from "./orb-graft-pages.js";
import { OrbOverlay } from "./orb-overlay.js";
import { ORB_BUBBLE_STATE, ORB_SUMMON_INFO } from "./orb-messages.js";
import {
  captureSummon,
  dropTarget,
  flashTarget,
  hideOutline,
  skipHost,
  trackPointer,
  type SummonInfo,
} from "./orb-target.js";

// Loaded on every http(s) page, and by Graft's own tab pages themselves, but adds nothing until the
// shortcut is pressed. While the orb is on, every page asks for it on load and when it becomes
// visible, so it follows the user. A Graft page framed in another (the side panel's chat) has none.

declare global {
  interface Window {
    __orbLoaded?: boolean;
  }
}

const graftPage = location.protocol === "chrome-extension:";

if (!window.__orbLoaded && (!graftPage || window.parent === window)) {
  window.__orbLoaded = true;
  start();
}

/** Brings the working overlay back when the tab shows again, or returns from the back/forward cache. */
function listenForRestore(restore: () => void): void {
  document.addEventListener("visibilitychange", restore);
  addEventListener("pageshow", (event) => {
    if (event.persisted) restore();
  });
}

function start(): void {
  let overlay: OrbOverlay | undefined;
  let recording = false;
  let summon: SummonInfo | undefined;
  if (!graftPage) trackPointer();

  // keepRunning: fold to the orb (Esc, click away, Minimize). Otherwise the orb goes everywhere:
  // the chat moved to the side panel or a tab. A run keeps going there.
  const close = (keepRunning: boolean) => {
    if (keepRunning) overlay?.hideBubble();
    else void chrome.runtime.sendMessage({ kind: ORB_OFF }).catch(() => undefined);
  };
  const show = (message: OrbToggle) => {
    if (!overlay) {
      followPageChat(message.tabId);
      overlay = new OrbOverlay(message.tabId, message.nonce);
      overlay.setRecording(recording);
      skipHost(overlay.element);
    }
    if (!message.open) return;
    // Read before the box opens over the page, so the box is never what the pointer is on.
    const keyboard = message.keyboard === true;
    summon = graftPage ? undefined : captureSummon();
    if (keyboard) summon = { ...(summon ?? { fillForm: false }), keyboard };
    overlay.showBubble(true, keyboard);
    const shown: OrbShown = { kind: "graft.orb.shown", tabId: message.tabId, summon };
    void chrome.runtime.sendMessage(shown).catch(() => undefined);
  };
  const restore = () => {
    if (overlay || document.visibilityState !== "visible") return;
    // A reloaded or updated extension leaves this script behind with no runtime, and
    // sendMessage then throws instead of rejecting.
    if (!chrome.runtime?.id) {
      document.removeEventListener("visibilitychange", restore);
      return;
    }
    void chrome.runtime
      .sendMessage({ kind: ORB_RESTORE })
      .then((reply: unknown) => {
        if (isOrbToggle(reply)) show(reply);
      })
      .catch(() => undefined);
  };
  restore();
  listenForRestore(restore);

  listenToCursorButtons(() => overlay !== undefined);
  listenForEscape(() => overlay);
  if (graftPage) listenForLocalCursor();

  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (isOrbToggle(message)) return show(message);
    const kind = (message as { kind?: unknown } | null)?.kind;
    if (kind === ORB_SUMMON_INFO) return void reply(summon ?? null);
    if (kind === ORB_DISMISS) {
      overlay?.destroy();
      overlay = undefined;
      return;
    }
    // The engine is recording this tab on video: keep the orb out of the picture.
    if (kind === "browserkit.recording") {
      recording = (message as { recording?: unknown }).recording === true;
      overlay?.setRecording(recording);
      return;
    }
    if (overlay && isOrbToContent(message)) toOverlay(overlay, message, close);
  });
}

function toOverlay(
  overlay: OrbOverlay,
  message: OrbToContent,
  close: (keepRunning: boolean) => void,
): void {
  if (message.kind === "graft.orb.hide") close(message.keepRunning);
  else if (message.kind === "graft.orb.target") onTarget(message.action);
  else overlay.apply(message);
}

function onTarget(action: "drop" | "hover" | "unhover"): void {
  if (action === "drop") dropTarget();
  else if (action === "hover") flashTarget(0);
  else hideOutline();
}

/** The shortcut asks whether the box is showing here: it opens when not, closes when it is. */
function listenForBubbleState(current: () => OrbOverlay | undefined): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if ((message as { kind?: unknown } | null)?.kind !== ORB_BUBBLE_STATE) return;
    reply({ open: current()?.bubbleOpen === true });
  });
}

function listenForEscape(current: () => OrbOverlay | undefined): void {
  listenForBubbleState(current);
  addEventListener(
    "keydown",
    (event) => {
      const overlay = current();
      if (event.key !== "Escape" || !overlay?.bubbleOpen) return;
      // Handled here, so browserkit does not also read this Esc as taking the tab over.
      event.preventDefault();
      overlay.hideBubble();
    },
    { capture: true },
  );
}

/** Graft's own pages draw the shared cursor themselves (chrome.scripting cannot reach them). */
function listenForLocalCursor(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id === chrome.runtime.id && isCursorLocal(message)) void drawLocalCursor(message);
  });
}

/** On a chat tab, the cursor box shows the chat on the page rather than the last one used. */
function followPageChat(tabId: number): void {
  const chatId = graftPage ? pageChatId(location.href) : undefined;
  if (chatId) void chrome.storage.session.set({ ["graft-orb-chat:" + tabId]: chatId });
}

/**
 * The cursor's ☰ and ■. The engine draws the glyphs in the page; the buttons that act are created
 * here, so a page that dispatches graft-cursor-stop or graft-cursor-transcript cannot forge them.
 * ☰ opens the transcript. ■ stops the chat this tab's cursor started, and with no cursor summoned
 * here it opens the transcript, where Stop is.
 */
function listenToCursorButtons(summoned: () => boolean): void {
  const send = (kind: string) => {
    if (chrome.runtime?.id) void chrome.runtime.sendMessage({ kind }).catch(() => undefined);
  };
  startCursorControls(send, summoned);
}
