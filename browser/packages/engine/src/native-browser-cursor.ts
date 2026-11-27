// The visible agent cursor and its caption, for the user watching the agent work. Purely
// cosmetic: every update is sent without awaiting, never fails or delays an action, ignores
// pointer input and stays out of the accessibility tree. Animation runs inside the page, so the
// agent moves on while the cursor is still gliding. The painter runs in the extension's isolated
// world (chrome.scripting), never through a CDP evaluation in the page's own world: page scripts
// cannot read its host's expandos, its state or its bus, and no Runtime call is made per frame.
import type { HandoffMeta } from "@browserkit/protocol";
import { CURSOR_SCRIPT_FILE } from "./cursor-page.js";
import {
  BADGE_FALLBACK,
  CURSOR_MARK,
  CURSOR_TOKEN_CSS,
  NEEDS_BADGE,
  NEUTRAL_GLOW,
} from "./cursor-mark.js";
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
  /** When the hand-off began, so the cursor box shows the wait without its own clock. */
  needsStartedAt?: number | null;
  /** Why the agent waits: a sign-in or check in the way, or a cliff edge (a commitment to approve). */
  needsKind?: string | null;
  /** The commitment a cliff-edge hand-off waits for, in words ("Pay $42.10"). */
  needsAction?: string | null;
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
// A cursor paint is fire-and-forget. Removing the cursor bumps its tab's epoch, so a paint that
// was already in flight cannot bring the host back after the agent's turn ended.
const epochs = new Map<number, number>();
function cursorEpoch(tabId: number): number {
  return epochs.get(tabId) ?? 0;
}
onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    lastPositions.delete(tabId);
    epochs.delete(tabId);
  });
});

/** A caption without moving the cursor, e.g. while reading or navigating. */
export function showAgentCaption(debuggee: chrome.debugger.Debuggee, caption: string): void {
  updateAgentCursor(debuggee, { caption, soft: true });
}

// Tabs being recorded on video: nothing of ours is drawn, or only the cursor when asked for.
const recording = new Map<number, { cursor: boolean; pill?: boolean }>();
/** cursor: Graft's cursor shows in the recording; pill: its pill, callouts and keys too (no glow). */
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
/** The agent waits for the user: the cursor turns amber, points (spotlight) and says why. */
export function showAgentNeeds(
  tabId: number,
  message: string | null,
  spotlight?: { x: number; y: number; width: number; height: number },
  meta: HandoffMeta = {},
  startedAt?: number,
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
      needsStartedAt: message !== null ? (startedAt ?? null) : null,
      needsKind: message !== null ? (meta.kind ?? null) : null,
      needsAction: message !== null ? (meta.actionLabel ?? null) : null,
      ...(message !== null ? { glow: false } : { glow: true, hideSpotlight: true }),
      ...(spotlight && message !== null ? { spotlight, ...point } : {}),
    },
  );
}

/** The edge glow around a tab an agent drives; dimmed while the user has control. */
export async function showAgentGlow(tabId: number, dim = false): Promise<void> {
  const epoch = cursorEpoch(tabId);
  if (!(await engineConfig.agentGlow().catch(() => true))) return;
  const glowColor = await engineConfig.agentGlowColor().catch(() => NEUTRAL_GLOW);
  if (epoch !== cursorEpoch(tabId)) return;
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
  const tabId = debuggee.tabId;
  const epoch = tabId === undefined ? 0 : cursorEpoch(tabId);
  void engineConfig
    .hideAgentCursor()
    .catch(() => false)
    .then((hidden) => {
      if (tabId !== undefined && epoch !== cursorEpoch(tabId)) return undefined;
      return hidden || tabId === undefined ? undefined : paintIsolated(tabId, update);
    })
    .catch(() => undefined);
}

async function paintIsolated(tabId: number, update: CursorUpdate): Promise<void> {
  const target = { tabId, frameIds: [0] };
  const paint = () =>
    chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: callPainter,
      args: [update, CURSOR_TOKEN_CSS, CURSOR_MARK],
    });
  const [first] = await paint();
  if (first?.result === true) return;
  await chrome.scripting.executeScript({ target, world: "ISOLATED", files: [CURSOR_SCRIPT_FILE] });
  await paint();
}
function callPainter(update: object, css: string, mark: object): boolean {
  // Injected with chrome.scripting into the isolated world: no imports, only that world's globals.
  const scope = globalThis as { __cursorPaint?: (u: object, c: string, m: object) => void };
  if (!scope.__cursorPaint) return false;
  scope.__cursorPaint(update, css, mark);
  return true;
}

/** Fade out and remove the cursor in a session's tabs (all tabs without a session), e.g. once
 * the agent's turn is over. */
export async function clearAgentCursors(chatId?: string): Promise<void> {
  await Promise.all(browserSessionTabs(chatId).map(removeAgentCursor));
}
export async function removeAgentCursor(tabId: number): Promise<void> {
  // A recording that asked for no cursor drops it. Otherwise a summoned cursor glides home.
  const drop = recording.get(tabId)?.cursor === false;
  epochs.set(tabId, cursorEpoch(tabId) + 1);
  await Promise.resolve()
    .then(() =>
      chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: removeCursor,
        args: [drop],
      }),
    )
    .catch(() => undefined);
}
function removeCursor(drop?: boolean): void {
  // Injected with chrome.scripting into the isolated world the painter runs in: no imports.
  const parent = document.documentElement || document.body;
  let host: HTMLElement | undefined;
  for (const child of Array.from(parent.children)) {
    if ((child as HTMLElement & { __cursorSurface?: boolean }).__cursorSurface) {
      host = child as HTMLElement;
      break;
    }
  }
  const surface = host as (HTMLElement & { __s?: { summoned?: boolean } }) | undefined;
  if (!host || !surface) return;
  if (!drop && surface.__s?.summoned) {
    // A summoned cursor glides home: a command on the isolated-world bus, never on the page's window.
    const scope = globalThis as { __cursorBus?: EventTarget };
    scope.__cursorBus?.dispatchEvent(
      new CustomEvent("cursor-overlay-command", { detail: { x: 0, y: 0, release: true } }),
    );
    return;
  }
  host.style.transition = "opacity 300ms ease";
  host.style.opacity = "0";
  setTimeout(() => host.remove(), 320);
}
