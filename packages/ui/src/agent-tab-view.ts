import { useEffect, useState } from "react";
// How the full-tab Chat shows the tabs its agent works in. The extension mirrors this key into
// chrome.storage so its worker can read it.
export type AgentTabView = "split" | "thumbnails";
export const agentTabViewKey = "aeonAgentTabView";
export function useAgentTabView(): [AgentTabView, (view: AgentTabView) => void] {
  const [view, setView] = useState<AgentTabView>("split");
  useEffect(() => {
    const read = () => {
      try {
        setView(localStorage.getItem(agentTabViewKey) === "thumbnails" ? "thumbnails" : "split");
      } catch {
        /* Storage may be unavailable in a preview. */
      }
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener(agentTabViewKey, read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener(agentTabViewKey, read);
    };
  }, []);
  return [
    view,
    (value) => {
      localStorage.setItem(agentTabViewKey, value);
      setView(value);
      window.dispatchEvent(new Event(agentTabViewKey));
    },
  ];
}
