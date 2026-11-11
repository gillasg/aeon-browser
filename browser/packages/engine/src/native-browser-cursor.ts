// The visible agent cursor and its caption, for the user watching the agent work. Purely
// cosmetic: every update is sent without awaiting, never fails or delays an action, ignores
// pointer input and stays out of the accessibility tree. Animation runs inside the page, so the
// agent moves on while the cursor is still gliding.
import { send } from "./cdp/send.js";
import { cursorExpression } from "./cursor-page.js";
import { BADGE_FALLBACK, NEEDS_BADGE, NEUTRAL_GLOW } from "./cursor-mark.js";
import { engineConfig } from "./engine-config.js";
import { browserSessionTabs } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
export interface CursorUpdate {
  x?: number;
  y?: number;
  /** Click: press the cursor down and ripple. */
  press?: boolean;
  /** I-beam over editable fields. */
  text?: boolean;
  /** Drag: draw a trail from here to x, y. */
  from?: { x: number; y: number };
  /** Caption pill shown beside the cursor. */
  caption?: string;
  /** Reveal the caption letter by letter (visible typing). */
  typing?: boolean;
  /** Skip if another caption appeared in the last moment (reads must not hide actions). */
  soft?: boolean;
  /** Dim the page around a target rectangle (viewport coordinates). */
  spotlight?: { x: number; y: number; width: number; height: number };
  hideSpotlight?: boolean;
  /** A label anchored to a target rectangle. */
  callout?: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    label: string;
    detail?: string;
  };
  /** Show keys being pressed for a moment. */
  keys?: string[];
  /** Caption is an obvious action (click/type): hide it after ~2 s instead of keeping it. */
  transient?: boolean;
  /** Edge glow around a tab an agent drives. */
  glow?: boolean;
  /** The user has control: dim the glow and stop its pulse. */
  glowDim?: boolean;
  /** Create the overlay for the glow without showing the cursor yet. */
  glowOnly?: boolean;
  /** CSS colour for the glow (hex or rgb()). */
  glowColor?: string;
  /** Initial viewport position when the overlay is recreated after a navigation. */
  start?: { x: number; y: number };
  /** The agent waits for the user: amber cursor and spotlight, no glow, the message as caption. */
  needs?: string | null;
  /** The tab is being recorded with the cursor: show only the cursor, nothing else of ours. */
  clean?: boolean;
  /** Summoned cursor: remember this point. Ignored while the agent is already driving it. */
  summon?: boolean;
  /** Jump to x, y instead of gliding (a drag). */
  place?: boolean;
  /** The agent let go: a summoned cursor may glide home. */
  release?: boolean;
}

export function showAgentCursor(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  press = false,
  extra: Omit<CursorUpdate, "x" | "y" | "press"> = {},
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const tabId = debuggee.tabId;
  const prior = tabId === undefined ? undefined : lastPositions.get(tabId);
  updateAgentCursor(debuggee, {
    ...extra,
    ...(prior && extra.start === undefined ? { start: prior } : {}),
    x: Math.round(x),
    y: Math.round(y),
    press,
  });
  if (tabId !== undefined) lastPositions.set(tabId, { x: Math.round(x), y: Math.round(y) });
}
const lastPositions = new Map<number, { x: number; y: number }>();
onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => lastPositions.delete(tabId));
});

/** A caption without moving the cursor, e.g. while reading or navigating. */
export function showAgentCaption(debuggee: chrome.debugger.Debuggee, caption: string): void {
  updateAgentCursor(debuggee, { caption, soft: true });
}

// Tabs being recorded on video: nothing of ours is drawn, or only the cursor when asked for.
const recording = new Map<number, { cursor: boolean; pill?: boolean }>();
/** cursor: Aeon's cursor shows in the recording; pill: its pill, callouts and keys too (no glow). */
export function setTabRecording(
  tabId: number,
  state: { cursor: boolean; pill?: boolean } | undefined,
): void {
  if (state) recording.set(tabId, state);
  else recording.delete(tabId);
  if (state && !state.cursor) void removeAgentCursor(tabId);
  if (state?.cursor) updateAgentCursor({ tabId }, { glow: false });
}
export function tabRecording(tabId: number): { cursor: boolean; pill?: boolean } | undefined {
  return recording.get(tabId);
}

/** The toolbar dot on a tab an agent drives: the product colour, amber while it needs the user.
 * Extensions cannot mark the tab itself, so the dot sits on the toolbar icon of that tab. */
export async function showAgentBadge(tabId: number, needs = false): Promise<void> {
  const glow = await engineConfig.agentGlowColor().catch(() => NEUTRAL_GLOW);
  const color = needs ? NEEDS_BADGE : glow === NEUTRAL_GLOW ? BADGE_FALLBACK : glow;
  await chrome.action.setBadgeText({ tabId, text: " " }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
}
/**
 * Page code that draws a hand-off's ask (amber cursor, pill with Done and Cancel). Run by the
 * hand-off itself, so an ask shows even with the cursor setting off or no debugger attached.
 */
export function agentNeedsExpression(
  message: string,
  spotlight?: { x: number; y: number; width: number; height: number },
): string {
  const point = spotlight
    ? {
        x: Math.round(spotlight.x + spotlight.width / 2),
        y: Math.round(spotlight.y + spotlight.height / 2),
      }
    : {};
  return cursorExpression({
    needs: message,
    glow: false,
    ...(spotlight ? { spotlight, ...point } : {}),
  });
}

/** The agent waits for the user: the cursor turns amber, points (spotlight) and says why. */
export function showAgentNeeds(
  tabId: number,
  message: string | null,
  spotlight?: { x: number; y: number; width: number; height: number },
): void {
  const point = spotlight
    ? {
        x: Math.round(spotlight.x + spotlight.width / 2),
        y: Math.round(spotlight.y + spotlight.height / 2),
      }
    : undefined;
  void showAgentBadge(tabId, message !== null);
  updateAgentCursor(
    { tabId },
    {
      needs: message,
      ...(message !== null ? { glow: false } : { glow: true, hideSpotlight: true }),
      ...(spotlight && message !== null ? { spotlight, ...point } : {}),
    },
  );
}

/** The edge glow around a tab an agent drives; dimmed while the user has control. */
export async function showAgentGlow(tabId: number, dim = false): Promise<void> {
  if (!(await engineConfig.agentGlow().catch(() => true))) return;
  const glowColor = await engineConfig.agentGlowColor().catch(() => NEUTRAL_GLOW);
  updateAgentCursor({ tabId }, { glow: true, glowDim: dim, glowOnly: true, glowColor });
}

export function dimAgentGlow(tabId: number, dim: boolean): void {
  updateAgentCursor({ tabId }, { glowDim: dim });
}

export function hideAgentGlow(tabId: number): void {
  updateAgentCursor({ tabId }, { glow: false });
}

/** Dim the page around a target, e.g. for a write confirmation or a hand-off. */
export function showAgentSpotlight(
  debuggee: chrome.debugger.Debuggee,
  rect: { x: number; y: number; width: number; height: number },
): void {
  updateAgentCursor(debuggee, { spotlight: rect });
}

export function hideAgentSpotlight(debuggee: chrome.debugger.Debuggee): void {
  updateAgentCursor(debuggee, { hideSpotlight: true });
}

/** A label anchored to a target, with an optional second line. */
export function showAgentCallout(
  debuggee: chrome.debugger.Debuggee,
  rect: { x: number; y: number; width?: number; height?: number },
  label: string,
  detail?: string,
): void {
  updateAgentCursor(debuggee, {
    callout: { ...rect, label, ...(detail !== undefined ? { detail } : {}) },
  });
}

/** Show the keys being pressed for a moment. */
export function showAgentKeys(debuggee: chrome.debugger.Debuggee, keys: string[]): void {
  updateAgentCursor(debuggee, { keys });
}

function updateAgentCursor(debuggee: chrome.debugger.Debuggee, update: CursorUpdate): void {
  const recorded = debuggee.tabId === undefined ? undefined : recording.get(debuggee.tabId);
  if (recorded && !recorded.cursor) return;
  if (recorded)
    update = recorded.pill ? { ...update, glow: false } : { ...update, clean: true, glow: false };
  void engineConfig
    .hideAgentCursor()
    .catch(() => false)
    .then((hidden) =>
      hidden
        ? undefined
        : send(
            debuggee,
            "Runtime.evaluate",
            { expression: cursorExpression(update), silent: true },
            { label: "updateAgentCursor", ms: 5_000 },
          ),
    )
    .catch(() => undefined);
}

/** Fade out and remove the cursor in a session's tabs (all tabs without a session), e.g. once
 * the agent's turn is over. */
export async function clearAgentCursors(chatId?: string): Promise<void> {
  await Promise.all(browserSessionTabs(chatId).map(removeAgentCursor));
}
export async function removeAgentCursor(tabId: number): Promise<void> {
  // A recording that asked for no cursor drops it. Otherwise a summoned cursor glides home.
  const drop = recording.get(tabId)?.cursor === false;
  await Promise.resolve()
    .then(() =>
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: removeCursor,
        args: [drop],
      }),
    )
    .catch(() => undefined);
}
function removeCursor(drop?: boolean): void {
  const host = document.getElementById("aeon-agent-cursor");
  if (!host) return;
  if (!drop && host.hasAttribute("data-aeon-summon")) {
    host.setAttribute("data-aeon-release", "1");
    return;
  }
  host.removeAttribute("data-aeon-summon");
  host.style.transition = "opacity 300ms ease";
  host.style.opacity = "0";
  setTimeout(() => host.remove(), 320);
}
