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
  let pointer: { x: number; y: number } | undefined;
  let overlay: OrbOverlay | undefined;
  addEventListener("pointermove", (event) => (pointer = { x: event.clientX, y: event.clientY }), {
    capture: true,
    passive: true,
  });
  const here = () => pointer ?? { x: innerWidth - 120, y: innerHeight - 120 };

  const close = (keepRunning: boolean) => {
    if (!overlay) return;
    if (keepRunning && overlay.running) overlay.hideBubble();
    else {
      overlay.destroy();
      overlay = undefined;
    }
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (isOrbToggle(message)) {
      if (overlay?.bubbleOpen) return close(true);
      overlay ??= new OrbOverlay(message.tabId, message.nonce, here());
      overlay.showBubble(here());
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
      if (event.key === "Escape" && overlay?.bubbleOpen) close(true);
    },
    { capture: true },
  );
}
