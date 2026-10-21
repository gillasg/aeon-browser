import type { OrbBox, OrbCursorStep, OrbStatus } from "./orb-run.js";

// Messages between the orb's three parts:
// - the service worker (shortcut, nonce),
// - the content script (swarm, cursor, spotlight, drawn over the page),
// - orb.html (the bubble, framed by the content script; the page cannot read it).

export const ORB_COMMAND = "summon-orb";

export type OrbVisualState = Exclude<OrbStatus, "idle"> | "listening";

/** orb.html → content script (chrome.tabs.sendMessage, top frame of its tab). */
export type OrbToContent =
  | { kind: "aeon.orb.visual"; state: OrbVisualState; label: string }
  | { kind: "aeon.orb.cursor"; steps: OrbCursorStep[] }
  | { kind: "aeon.orb.spotlight"; box: OrbBox | null }
  | { kind: "aeon.orb.panel"; width: number; height: number }
  | { kind: "aeon.orb.hide"; keepRunning: boolean };

/** Service worker → content script. */
export interface OrbToggle {
  kind: "aeon.orb.toggle";
  tabId: number;
  nonce: string;
}

/** Content script → orb.html (chrome.runtime.sendMessage, filtered by tab). */
export interface OrbShown {
  kind: "aeon.orb.shown";
  tabId: number;
}

/** orb.html → service worker: proves it was framed by the content script for this tab. */
export interface OrbVerify {
  kind: "aeon.orb.verify";
  tabId: number;
  nonce: string;
}

const CONTENT_KINDS = new Set([
  "aeon.orb.visual",
  "aeon.orb.cursor",
  "aeon.orb.spotlight",
  "aeon.orb.panel",
  "aeon.orb.hide",
]);

export function isOrbToContent(value: unknown): value is OrbToContent {
  return (
    typeof value === "object" &&
    value !== null &&
    CONTENT_KINDS.has(String((value as { kind?: unknown }).kind))
  );
}

export function isOrbToggle(value: unknown): value is OrbToggle {
  const message = value as Partial<OrbToggle> | null;
  return (
    message?.kind === "aeon.orb.toggle" &&
    Number.isSafeInteger(message.tabId) &&
    typeof message.nonce === "string"
  );
}

export function nonceKey(nonce: string): string {
  return "aeon-orb-nonce:" + nonce;
}
