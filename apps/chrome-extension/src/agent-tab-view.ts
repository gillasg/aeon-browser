// The Agent tabs setting lives in page localStorage (where the settings UI keeps its choices);
// the worker cannot read that, so extension pages mirror it into chrome.storage.local.
export const AGENT_TAB_VIEW_KEY = "aeonAgentTabView";
export type AgentTabView = "split" | "thumbnails";

export function mirrorAgentTabView(): void {
  const push = () => {
    let view: AgentTabView = "split";
    try {
      if (localStorage.getItem(AGENT_TAB_VIEW_KEY) === "thumbnails") view = "thumbnails";
    } catch {
      /* Storage may be unavailable. */
    }
    void chrome.storage.local.set({ [AGENT_TAB_VIEW_KEY]: view }).catch(() => undefined);
  };
  push();
  window.addEventListener("storage", push);
  window.addEventListener(AGENT_TAB_VIEW_KEY, push);
}

export async function readAgentTabView(): Promise<AgentTabView> {
  const stored = await chrome.storage.local.get(AGENT_TAB_VIEW_KEY);
  return stored[AGENT_TAB_VIEW_KEY] === "thumbnails" ? "thumbnails" : "split";
}
