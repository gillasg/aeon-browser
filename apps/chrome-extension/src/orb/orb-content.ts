import {
  ORB_DISMISS,
  ORB_OFF,
  ORB_RESTORE,
  isOrbToContent,
  isOrbToggle,
  type OrbShown,
  type OrbToggle,
} from "./orb-messages.js";
import { OrbOverlay } from "./orb-overlay.js";

// Loaded on every http(s) page but adds nothing to it until the shortcut is pressed. While the
// orb is on, every page asks for it on load and when it becomes visible, so it follows the user.

declare global {
  interface Window {
    __aeonOrbLoaded?: boolean;
  }
}

if (!window.__aeonOrbLoaded) {
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
    void chrome.runtime
      .sendMessage({ kind: ORB_RESTORE })
      .then((reply: unknown) => {
        if (isOrbToggle(reply)) show(reply);
      })
      .catch(() => undefined);
  };
  restore();
  document.addEventListener("visibilitychange", restore);

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

  addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !overlay?.bubbleOpen) return;
      // Handled here, so browserkit does not also read this Esc as taking the tab over.
      event.preventDefault();
      overlay.hideBubble();
    },
    { capture: true },
  );
}
