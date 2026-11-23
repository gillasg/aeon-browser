import { useEffect, useState } from "react";
// On/off agent settings. The extension mirrors these keys into chrome.storage so its worker can
// read them. Both are off by default. Screen recorders
// (Aeon Recorder) rely on them (the agent's work in the visible tab, no second cursor); keep them.
export const agentInFrontKey = "aeonAgentInFront";
export const hideAgentCursorKey = "aeonHideAgentCursor";
/** Record every tab a chat drives, for screen recorders (Aeon Recorder); keep it. */
export const recordAgentTabsKey = "aeonRecordAgentTabs";
/** Curved pointer and real keystrokes. Off by default; speed wins until the user turns it on. */
export const humanLikeInputKey = "aeonHumanLikeInput";
/** Manage → Advanced: shows Pi's tools and the context ring in the side panel. Off by default. */
export const developerModeKey = "aeonDeveloperMode";
/** Settings: thinking between a turn's steps. On by default. */
export const showThinkingKey = "aeonShowThinking";
/** Settings → Developer options: Pi's `/` slash commands in the composer. Off by default. */
export const piSlashCommandsKey = "aeonPiSlashCommands";
/** A stored on/off flag; `fallback` is its value until the user sets it. */
export function useAgentFlag(key: string, fallback = false): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(fallback);
  useEffect(() => {
    const read = () => {
      try {
        const stored = localStorage.getItem(key);
        setOn(stored === null ? fallback : stored === "on");
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
  }, [key, fallback]);
  return [
    on,
    (value) => {
      localStorage.setItem(key, value ? "on" : "off");
      setOn(value);
      window.dispatchEvent(new Event(key));
    },
  ];
}
