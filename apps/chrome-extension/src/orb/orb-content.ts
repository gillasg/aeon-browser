import { isOrbToContent, isOrbToggle, type OrbShown } from "./orb-messages.js";
import { OrbOverlay } from "./orb-overlay.js";

// Loaded on every http(s) page but adds nothing to it until the shortcut is pressed.

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

  // keepRunning: collapse to the orb (Esc, click away). Otherwise the orb goes: the shortcut
  // again, Close, or the chat moving to the side panel or a tab. A run keeps going there.
  const close = (keepRunning: boolean) => {
    if (!overlay) return;
    if (keepRunning) overlay.hideBubble();
    else {
      overlay.destroy();
      overlay = undefined;
    }
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (isOrbToggle(message)) {
      // The shortcut summons the orb, and pressing it again dismisses it.
      if (overlay) return close(false);
      overlay = new OrbOverlay(message.tabId, message.nonce);
      overlay.setRecording(recording);
      overlay.showBubble();
      const shown: OrbShown = { kind: "aeon.orb.shown", tabId: message.tabId };
      void chrome.runtime.sendMessage(shown).catch(() => undefined);
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
      if (event.key === "Escape" && overlay?.bubbleOpen) overlay.hideBubble();
    },
    { capture: true },
  );
}
