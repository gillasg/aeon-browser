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

  // keepRunning: collapse to the orb (Esc, hand-off). Otherwise dismiss the orb, unless a run
  // is still going, in which case it stays as an orb.
  const close = (keepRunning: boolean) => {
    if (!overlay) return;
    if (keepRunning || overlay.running) overlay.hideBubble();
    else {
      overlay.destroy();
      overlay = undefined;
    }
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (isOrbToggle(message)) {
      // The shortcut toggles the box; the orb itself stays until it is dismissed.
      if (overlay?.bubbleOpen) return overlay.hideBubble();
      overlay ??= new OrbOverlay(message.tabId, message.nonce);
      overlay.showBubble();
      const shown: OrbShown = { kind: "aeon.orb.shown", tabId: message.tabId };
      void chrome.runtime.sendMessage(shown).catch(() => undefined);
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
