import { useEffect, useState } from "react";
export type MessageSendMode = "followUp" | "steer";
const key = "pippinMessageSendMode";
export function useMessageSendMode(): [MessageSendMode, (mode: MessageSendMode) => void] {
  const [mode, setMode] = useState<MessageSendMode>("followUp");
  useEffect(() => {
    const read = () => {
      try {
        setMode(localStorage.getItem(key) === "steer" ? "steer" : "followUp");
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
  }, []);
  return [
    mode,
    (value) => {
      localStorage.setItem(key, value);
      setMode(value);
      window.dispatchEvent(new Event(key));
    },
  ];
}
