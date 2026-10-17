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
  push();
  window.addEventListener("storage", push);
  for (const key of [AGENT_TAB_VIEW_KEY, ...FLAGS]) window.addEventListener(key, push);
}

export async function readAgentFlag(key: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(key);
  return stored[key] === true;
}

export async function readAgentTabView(): Promise<AgentTabView> {
  const stored = await chrome.storage.local.get(AGENT_TAB_VIEW_KEY);
  return stored[AGENT_TAB_VIEW_KEY] === "thumbnails" ? "thumbnails" : "split";
}
