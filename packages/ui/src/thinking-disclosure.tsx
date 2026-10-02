import { useEffect, useRef, type ReactElement } from "react";
import { ChatMarkdown } from "./chat-markdown.js";
import { PickerChevron } from "./picker-chevron.js";
export function ThinkingDisclosure({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): ReactElement | null {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (streaming && details.current) details.current.open = true;
  }, [streaming, Boolean(text.trim())]);
  if (!text.trim()) return null;
  return (
    <details ref={details} className="thinking-detail" data-streaming={String(streaming)}>
      <summary>
        Thinking <PickerChevron />
      </summary>
      <ChatMarkdown text={text} />
    </details>
  );
}
