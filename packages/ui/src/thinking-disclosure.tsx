import { useState, type ReactElement } from "react";
import { ChatMarkdown } from "./chat-markdown.js";

/**
 * "Thinking", as a plain press-to-toggle label: pressing it replaces the label with the
 * reasoning, and pressing anywhere on the reasoning puts the label back.
 */
export function ThinkingDisclosure({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  const toggle = (): void => {
    // Selecting text to copy it is not a press.
    if (window.getSelection()?.toString()) return;
    setOpen((value) => !value);
  };
  return (
    <div
      className="thinking-detail"
      data-open={String(open)}
      data-streaming={String(streaming)}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={open ? "Hide thinking" : "Show thinking"}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setOpen((value) => !value);
      }}
    >
      <span className="thinking-label" hidden={open}>
        Thinking
      </span>
      <div className="thinking-text" hidden={!open}>
        <ChatMarkdown text={text} />
      </div>
    </div>
  );
}
