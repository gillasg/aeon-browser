// The Agent tabs setting lives in page localStorage (where the settings UI keeps its choices);
// the worker cannot read that, so extension pages mirror it into chrome.storage.local.
export const AGENT_TAB_VIEW_KEY = "aeonAgentTabView";
export type AgentTabView = "split" | "thumbnails";
// On/off agent settings, off by default. Screen recorders (Aperture) rely on them; keep them.
export const AGENT_IN_FRONT_KEY = "aeonAgentInFront";
export const HIDE_AGENT_CURSOR_KEY = "aeonHideAgentCursor";
const FLAGS = [AGENT_IN_FRONT_KEY, HIDE_AGENT_CURSOR_KEY];

export function mirrorAgentTabView(): void {
  const push = () => {
    let view: AgentTabView = "split";
    try {
      if (localStorage.getItem(AGENT_TAB_VIEW_KEY) === "thumbnails") view = "thumbnails";
    } catch {
      /* Storage may be unavailable. */
    }
    const flags: Record<string, boolean> = {};
    for (const key of FLAGS) {
      try {
        flags[key] = localStorage.getItem(key) === "on";
      } catch {
        flags[key] = false;
      }
    }
    void chrome.storage.local.set({ [AGENT_TAB_VIEW_KEY]: view, ...flags }).catch(() => undefined);
  };
  // Settings changed outside this page (`aeon settings` from the CLI) win over the page's copy.
  void adoptStored().then(push, push);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") adopt(changes);
  });
  window.addEventListener("storage", push);
  for (const key of [AGENT_TAB_VIEW_KEY, ...FLAGS]) window.addEventListener(key, push);
}

async function adoptStored(): Promise<void> {
  const stored = await chrome.storage.local.get([AGENT_TAB_VIEW_KEY, ...FLAGS]);
  adopt(Object.fromEntries(Object.entries(stored).map(([key, newValue]) => [key, { newValue }])));
}

function adopt(changes: Record<string, { newValue?: unknown }>): void {
  for (const key of [AGENT_TAB_VIEW_KEY, ...FLAGS]) {
    const value = changes[key]?.newValue;
    if (value === undefined) continue;
    const text = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
    try {
      if (localStorage.getItem(key) === text) continue;
      localStorage.setItem(key, text);
      window.dispatchEvent(new Event(key));
    } catch {
      /* Storage may be unavailable. */
    }
  }
}

export async function readAgentFlag(key: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(key);
  return stored[key] === true;
}

export async function readAgentTabView(): Promise<AgentTabView> {
  const stored = await chrome.storage.local.get(AGENT_TAB_VIEW_KEY);
  return stored[AGENT_TAB_VIEW_KEY] === "thumbnails" ? "thumbnails" : "split";
}
