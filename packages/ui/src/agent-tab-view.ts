import { useEffect, useState } from "react";
// How the full-tab Chat shows the tabs its agent works in. The extension mirrors this key into
// chrome.storage so its worker can read it.
export type AgentTabView = "auto" | "split" | "thumbnails";
export const agentTabViewKey = "aeonAgentTabView";
// On/off agent settings, mirrored the same way. Both are off by default. Screen recorders
// (Aperture) rely on them (the agent's work in the visible tab, no second cursor); keep them.
export const agentInFrontKey = "aeonAgentInFront";
export const hideAgentCursorKey = "aeonHideAgentCursor";
export function useAgentFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        setOn(localStorage.getItem(key) === "on");
      } catch {
        /* Storage may be unavailable in a preview. */
      }
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener(key, read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener(key, read);
    };
  }, [key]);
  return [
    on,
    (value) => {
      localStorage.setItem(key, value ? "on" : "off");
      setOn(value);
      window.dispatchEvent(new Event(key));
    },
  ];
}
export function useAgentTabView(): [AgentTabView, (view: AgentTabView) => void] {
  const [view, setView] = useState<AgentTabView>("auto");
  useEffect(() => {
    const read = () => {
      try {
        const stored = localStorage.getItem(agentTabViewKey);
        setView(stored === "split" || stored === "thumbnails" ? stored : "auto");
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
