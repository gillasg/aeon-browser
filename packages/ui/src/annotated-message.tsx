import type { ReactElement } from "react";
import { ChatMarkdown } from "./chat-markdown.js";
export function AnnotatedMessage({ text, user }: { text: string; user: boolean }): ReactElement {
  const parsed = user ? parseAnnotations(text) : null;
  if (!parsed) return <ChatMarkdown text={text} />;
  return (
    <>
      {parsed.prompt && <ChatMarkdown text={parsed.prompt} />}
      <div className="sent-annotations" aria-label="Sent response annotations">
        {parsed.annotations.map((annotation, index) => (
          <div key={index}>
            <small>Selection {index + 1}</small>
            <blockquote>{annotation.quote}</blockquote>
            {annotation.comment && <p>{annotation.comment}</p>}
          </div>
        ))}
      </div>
    </>
  );
}
function parseAnnotations(text: string): {
  prompt: string;
  annotations: Array<{ quote: string; comment: string }>;
} | null {
  // Messages sent before the rename carry the old Pippin tag.
  const tag = ["Aeon", "Pippin"].find((name) => text.endsWith(`\n\n[/${name} annotations v1]`));
  if (!tag) return null;
  const opening = `[${tag} annotations v1]\n\n`;
  const closing = `\n\n[/${tag} annotations v1]`;
  const start = text.lastIndexOf(opening);
  if (start < 0 || !text.endsWith(closing)) return null;
  const body = text.slice(start + opening.length, -closing.length);
  const blocks = body.split(/\n\n(?=Annotation \d+:\n)/);
  const annotations = blocks.map((block) => {
    const match = /^Annotation \d+:\n\n((?:> [^\n]*(?:\n|$))+)(?:\n([\s\S]*))?$/.exec(block);
    if (!match) return null;
    return {
      quote: (match[1] ?? "")
        .split("\n")
        .map((line) => line.replace(/^> /, ""))
        .join("\n")
        .trim(),
      comment: (match[2] ?? "").trim(),
    };
  });
  if (!annotations.length || annotations.some((annotation) => !annotation)) return null;
  return {
    prompt: text.slice(0, start).trim(),
    annotations: annotations.filter((item) => item !== null),
  };
}
