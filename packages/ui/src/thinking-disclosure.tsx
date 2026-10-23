import type { ReactElement } from "react";
import { ChatMarkdown } from "./chat-markdown.js";

/**
 * "Thinking", as a plain press-to-toggle label: pressing it shows the reasoning, pressing it
 * again hides it. No caret or dropdown chrome.
 */
export function ThinkingDisclosure({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): ReactElement | null {
  if (!text.trim()) return null;
  return (
    <details className="thinking-detail" data-streaming={String(streaming)}>
      <summary>Thinking</summary>
      <ChatMarkdown text={text} />
    </details>
  );
}
