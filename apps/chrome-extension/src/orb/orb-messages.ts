import type { OrbBox, OrbCursorStep, OrbStatus } from "./orb-run.js";

// Messages between the orb's three parts:
// - the service worker (shortcut, nonce),
// - the content script (swarm, cursor, spotlight, drawn over the page),
// - orb.html (the island, framed by the content script; the page cannot read it).

export const ORB_COMMAND = "summon-orb";

/** "paused": the user took over and is driving the page. */
export type OrbVisualState = Exclude<OrbStatus, "idle"> | "listening" | "paused";

/** orb.html → content script (chrome.tabs.sendMessage, top frame of its tab). */
export type OrbToContent =
  | { kind: "aeon.orb.visual"; state: OrbVisualState; label: string }
  | { kind: "aeon.orb.cursor"; steps: OrbCursorStep[] }
  /** A step finished in another tab (the agent's own). */
  | { kind: "aeon.orb.elsewhere" }
  /** How many chats are working right now: the swarm splits into that many. */
  | { kind: "aeon.orb.agents"; count: number }
  | { kind: "aeon.orb.spotlight"; box: OrbBox | null }
  | { kind: "aeon.orb.panel"; width: number; height: number }
  /** keepRunning: collapse to the orb. false: dismiss the orb unless a run is going. */
  | { kind: "aeon.orb.hide"; keepRunning: boolean }
  | { kind: "aeon.orb.prefs"; reduceMotion: boolean };

/** Service worker → content script: show the orb here (open: with its box open). */
export interface OrbToggle {
  kind: "aeon.orb.toggle";
  tabId: number;
  nonce: string;
  open: boolean;
}

/** Service worker → every content script: the orb was dismissed (the shortcut, or a move). */
export const ORB_DISMISS = "aeon.orb.dismiss";
/** Content script → service worker on load: is the orb on? Answers an OrbToggle or null. */
export const ORB_RESTORE = "aeon.orb.restore";
/** orb.html → service worker: turn the orb off everywhere. */
export const ORB_OFF = "aeon.orb.off";
/** Session storage: the orb was summoned and follows the user across tabs until dismissed. */
export const ORB_ON_KEY = "aeon-orb-on";

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
  "aeon.orb.elsewhere",
  "aeon.orb.agents",
  "aeon.orb.spotlight",
  "aeon.orb.panel",
  "aeon.orb.hide",
  "aeon.orb.prefs",
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
