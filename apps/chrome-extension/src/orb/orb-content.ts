import {
  ORB_DISMISS,
  ORB_OFF,
  ORB_RESTORE,
  isOrbToContent,
  isOrbToggle,
  type OrbShown,
  type OrbToggle,
} from "./orb-messages.js";
import { startCursorControls } from "./cursor-controls.js";
import { drawLocalCursor, isCursorLocal, pageChatId } from "./orb-aeon-pages.js";
import { OrbOverlay } from "./orb-overlay.js";

// Loaded on every http(s) page, and by Aeon's own tab pages themselves, but adds nothing until the
// shortcut is pressed. While the orb is on, every page asks for it on load and when it becomes
// visible, so it follows the user. An Aeon page framed in another (the side panel's chat) has none.

declare global {
  interface Window {
    __aeonOrbLoaded?: boolean;
  }
}

const aeonPage = location.protocol === "chrome-extension:";

if (!window.__aeonOrbLoaded && (!aeonPage || window.parent === window)) {
  window.__aeonOrbLoaded = true;
  start();
}

function start(): void {
  let overlay: OrbOverlay | undefined;
  let recording = false;

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
    }
    if (!message.open) return;
    overlay.showBubble();
    const shown: OrbShown = { kind: "aeon.orb.shown", tabId: message.tabId };
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
  document.addEventListener("visibilitychange", restore);

  listenToCursorButtons(() => overlay !== undefined);
  listenForEscape(() => overlay);
  if (aeonPage) listenForLocalCursor();

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (isOrbToggle(message)) return show(message);
    if ((message as { kind?: unknown } | null)?.kind === ORB_DISMISS) {
      overlay?.destroy();
      overlay = undefined;
      return;
    }
    // The engine is recording this tab on video: keep the orb out of the picture.
    if ((message as { kind?: unknown } | null)?.kind === "browserkit.recording") {
      recording = (message as { recording?: unknown }).recording === true;
      overlay?.setRecording(recording);
      return;
    }
    if (!overlay || !isOrbToContent(message)) return;
    if (message.kind === "aeon.orb.hide") close(message.keepRunning);
    else overlay.apply(message);
  });
}

function listenForEscape(current: () => OrbOverlay | undefined): void {
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

/** Aeon's own pages draw the shared cursor themselves (chrome.scripting cannot reach them). */
function listenForLocalCursor(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id === chrome.runtime.id && isCursorLocal(message)) void drawLocalCursor(message);
  });
}

/** On a chat tab, the cursor box shows the chat on the page rather than the last one used. */
function followPageChat(tabId: number): void {
  const chatId = aeonPage ? pageChatId(location.href) : undefined;
  if (chatId) void chrome.storage.session.set({ ["aeon-orb-chat:" + tabId]: chatId });
}

/**
 * The cursor's ☰ and ■. The engine draws the glyphs in the page; the buttons that act are created
 * here, so a page that dispatches aeon-cursor-stop or aeon-cursor-transcript cannot forge them.
 * ☰ opens the transcript. ■ stops the chat this tab's cursor started, and with no cursor summoned
 * here it opens the transcript, where Stop is.
 */
function listenToCursorButtons(summoned: () => boolean): void {
  const send = (kind: string) => {
    if (chrome.runtime?.id) void chrome.runtime.sendMessage({ kind }).catch(() => undefined);
  };
  startCursorControls(send, summoned);
}
