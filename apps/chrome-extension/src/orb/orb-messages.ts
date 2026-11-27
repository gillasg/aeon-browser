import type { OrbBox, OrbCursorStep, OrbStatus } from "./orb-run.js";
import type { SummonInfo } from "./orb-target.js";

// Messages between the orb's three parts:
// - the service worker (shortcut, nonce),
// - the content script (the cursor, its pill and the spotlight, drawn over the page),
// - orb.html (the island, framed by the content script; the page cannot read it).

export const ORB_COMMAND = "summon-orb";

/** "paused": the user took over and is driving the page. */
export type OrbVisualState = Exclude<OrbStatus, "idle"> | "listening" | "paused";

/** orb.html → content script (chrome.tabs.sendMessage, top frame of its tab). */
export type OrbToContent =
  | { kind: "graft.orb.visual"; state: OrbVisualState; label: string }
  | { kind: "graft.orb.cursor"; steps: OrbCursorStep[] }
  | { kind: "graft.orb.spotlight"; box: OrbBox | null }
  /**
   * The box's measured size and the layout it wants: `answer` widens a pointer summon to 440px,
   * `teach` folds it to the bottom-centre pill while the page stays fully usable.
   */
  | {
      kind: "graft.orb.panel";
      width: number;
      height: number;
      layout?: OrbLayout;
    }
  /** keepRunning: collapse to the orb. false: dismiss the orb unless a run is going. */
  | { kind: "graft.orb.hide"; keepRunning: boolean }
  | { kind: "graft.orb.prefs"; reduceMotion: boolean }
  /** The target chip: dropped (× or Backspace), or hovered (outline the element again). */
  | { kind: "graft.orb.target"; action: "drop" | "hover" | "unhover" };

/** How the box sits: beside the pointer (400, answer 440), keyboard-centred (480), or Teach's pill. */
export type OrbLayout = "compose" | "answer" | "teach";

/** orb.html → content script: what the last summon pointed at (asked once the box has loaded). */
export const ORB_SUMMON_INFO = "graft.orb.summon-info";

/** Service worker → content script: show the orb here (open: with its box open). */
export interface OrbToggle {
  kind: "graft.orb.toggle";
  tabId: number;
  nonce: string;
  open: boolean;
  /** Summoned from the keyboard shortcut: the box opens centred, Spotlight-style, at 480px. */
  keyboard?: boolean;
}

/** Service worker → every content script: the orb was dismissed (the shortcut, or a move). */
export const ORB_DISMISS = "graft.orb.dismiss";
/** Content script → service worker on load: is the orb on? Answers an OrbToggle or null. */
export const ORB_RESTORE = "graft.orb.restore";
/** orb.html → service worker: turn the orb off everywhere. */
export const ORB_OFF = "graft.orb.off";
/** Content script → service worker: open this tab's transcript in the side panel (the cursor's ☰). */
export const CURSOR_TRANSCRIPT = "graft.cursor.transcript";
/** orb.html → service worker: open the side panel on this chat (⌘↵, Open in panel). The worker
 * opens it, the same path the cursor's ☰ takes, so the click's gesture reaches sidePanel.open. */
export const ORB_TO_PANEL = "graft.orb.to-panel";
/** Service worker → content script: is the box open in this tab? The shortcut's one source of truth. */
export const ORB_BUBBLE_STATE = "graft.orb.bubble-state";
/** Content script → service worker: install the shared page cursor in this tab. */
export const CURSOR_INSTALL = "graft.cursor.install";
/** Content script → this tab's orb.html: stop its chat (the cursor's ■). */
export const CURSOR_STOP = "graft.cursor.stop";
/** Session storage: the orb was summoned and follows the user across tabs until dismissed. */
export const ORB_ON_KEY = "graft-orb-on";

/** Content script → orb.html (chrome.runtime.sendMessage, filtered by tab). */
export interface OrbShown {
  kind: "graft.orb.shown";
  tabId: number;
  /** The selection or element the pointer was on, and whether the page has a form to fill. */
  summon?: SummonInfo | undefined;
}

/** orb.html → service worker: proves it was framed by the content script for this tab. */
export interface OrbVerify {
  kind: "graft.orb.verify";
  tabId: number;
  nonce: string;
}

const CONTENT_KINDS = new Set([
  "graft.orb.visual",
  "graft.orb.cursor",
  "graft.orb.spotlight",
  "graft.orb.panel",
  "graft.orb.hide",
  "graft.orb.prefs",
  "graft.orb.target",
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
    message?.kind === "graft.orb.toggle" &&
    Number.isSafeInteger(message.tabId) &&
    typeof message.nonce === "string"
  );
}

export function nonceKey(nonce: string): string {
  return "graft-orb-nonce:" + nonce;
}
