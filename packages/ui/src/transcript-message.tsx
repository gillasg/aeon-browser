import type { ReactElement } from "react";
import type { PiContentBlockDto, PiMessageDto } from "@pippin/protocol";
import { BrowserContextCard, BrowserContextTranscriptChip } from "./browser-context-view.js";
import { AnnotatedMessage } from "./annotated-message.js";
import { ThinkingDisclosure } from "./thinking-disclosure.js";
import { MessageActions } from "./message-actions.js";
import type { TranscriptRow } from "./transcript-model.js";

export function TranscriptMessage({
  row,
  onEditEntry,
  onBranchEntry,
  actionsDisabled,
  hideThinking = false,
}: {
  row: Exclude<TranscriptRow, { kind: "tool-group" }>;
  onEditEntry?: (entryId: string) => Promise<void> | void;
  onBranchEntry?: (entryId: string) => Promise<void> | void;
  actionsDisabled: boolean;
  hideThinking?: boolean;
}): ReactElement | null {
  const { message, entry, isUser, text, className } = messagePresentation(row);
  if (messageIsEmpty(message, hideThinking)) return null;
  const visibleMessage = messageWithoutThinking(message, hideThinking);
  return (
    <article className={`message-row ${className}`} data-pi-entry-id={entry?.entryId}>
      {isUser && message && <MessageContext message={message} />}
      <div className="message-content">
        {row.kind === "context-orphan" && (
          <p className="message-text">Page context wasn’t linked to a user prompt.</p>
        )}
        {visibleMessage && (
          <MessageBody message={visibleMessage} streaming={row.kind === "transient"} />
        )}
        {message?.errorMessage && (
          <p className="message-error" role="alert">
            {message.errorMessage}
          </p>
        )}
      </div>
      {messageActionsVisible(message, text, Boolean(entry)) && (
        <MessageActions
          message={message}
          entry={entry}
          onEditEntry={onEditEntry}
          onBranchEntry={onBranchEntry}
          actionsDisabled={actionsDisabled}
          text={text}
        />
      )}
    </article>
  );
}

function messageRowClass(message: PiMessageDto | null): string {
  if (message?.content.some((block) => block.type === "thread-message"))
    return "thread-message-row";
  return message?.role === "user" ? "user" : "assistant";
}

function MessageContext({ message }: { message: PiMessageDto }): ReactElement | null {
  if (!message.content.some((block) => block.type === "browser-context")) return null;
  return (
    <div className="message-context" aria-label="Page context sent with this message">
      {message.content.map((block) =>
        block.type === "browser-context" ? (
          <BrowserContextTranscriptChip key={block.record.contextId} record={block.record} />
        ) : null,
      )}
    </div>
  );
}

function MessageBody({
  message,
  streaming,
}: {
  message: PiMessageDto;
  streaming: boolean;
}): ReactElement {
  const content =
    message.role === "user"
      ? message.content.filter((block) => block.type !== "browser-context")
      : message.content;
  return <MessageContent content={content} streaming={streaming} user={message.role === "user"} />;
}

function MessageContent({
  content,
  streaming,
  user,
}: {
  content: readonly PiContentBlockDto[];
  streaming: boolean;
  user: boolean;
}): ReactElement {
  const text = content
    .filter((block): block is Extract<PiContentBlockDto, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  const details = content.filter((block) => block.type !== "text");
  const routineResults = new Map(
    details
      .filter(
        (block): block is Extract<PiContentBlockDto, { type: "routine-result" }> =>
          block.type === "routine-result",
      )
      .map((block) => [block.runId, block]),
  );
  const routineInvocations = new Set(
    details
      .filter(
        (block): block is Extract<PiContentBlockDto, { type: "routine-invocation" }> =>
          block.type === "routine-invocation",
      )
      .map((block) => block.runId),
  );
  return (
    <>
      {details.map((block, index) => {
        if (block.type === "routine-invocation") {
          const result = routineResults.get(block.runId);
          return (
            <RoutineInvocation
              block={block}
              {...(result ? { result } : {})}
              key={messageBlockKey(block, index)}
            />
          );
        }
        if (block.type === "routine-result" && routineInvocations.has(block.runId)) return null;
        return (
          <MessageBlock block={block} streaming={streaming} key={messageBlockKey(block, index)} />
        );
      })}
      {text && <AnnotatedMessage text={text} user={user} />}
    </>
  );
}

function MessageBlock({
  block,
  streaming,
}: {
  streaming: boolean;
  block: Exclude<PiContentBlockDto, { type: "text" | "routine-invocation" }>;
}): ReactElement | null {
  switch (block.type) {
    case "browser-context":
      return <BrowserContextCard record={block.record} />;
    case "thread-message":
      return <ThreadMessageCard block={block} />;
    case "routine-result":
      return <RoutineResult block={block} />;
    case "image":
      return (
        <p className="message-image">
          Image attached · {block.mimeType} · {block.byteLength} bytes
        </p>
      );
    case "thinking":
      return <ThinkingDisclosure text={block.text} streaming={streaming} />;
    default:
      return null;
  }
}

function ThreadMessageCard({
  block,
}: {
  block: Extract<PiContentBlockDto, { type: "thread-message" }>;
}): ReactElement {
  return (
    <section className="thread-message-card">
      <header>Message from {block.senderTitle}</header>
      <p className="message-text">{block.message}</p>
      {block.inReplyTo && <small>Reply to delivery {block.inReplyTo}</small>}
    </section>
  );
}

function RoutineInvocation({
  block,
  result,
}: {
  block: Extract<PiContentBlockDto, { type: "routine-invocation" }>;
  result?: Extract<PiContentBlockDto, { type: "routine-result" }>;
}): ReactElement {
  const failed = result?.state === "failed";
  return (
    <details className="routine-activity" data-run-id={block.runId}>
      <summary>
        <RoutineIcon />
        <span className="routine-activity-title">Viewed routine · {block.title}</span>
        {result && (
          <span className={`activity-state-badge ${failed ? "is-error" : ""}`}>
            {failed ? "Error" : "Done"}
          </span>
        )}
        <svg className="routine-activity-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m4 2 4 4-4 4" />
        </svg>
      </summary>
      <p className="routine-activity-slot">{block.scheduledSlot}</p>
      <p className="routine-activity-instruction">{block.instruction}</p>
    </details>
  );
}

function RoutineIcon(): ReactElement {
  return (
    <svg className="routine-activity-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11.1 2.7 4.8 10h4.4l-.4 7.3 6.4-8h-4.5z" />
    </svg>
  );
}

function RoutineResult({
  block,
}: {
  block: Extract<PiContentBlockDto, { type: "routine-result" }>;
}): ReactElement {
  const failed = block.state === "failed";
  return (
    <div className="routine-result" data-state={block.state} data-run-id={block.runId}>
      <span>{failed ? "Routine failed" : "Routine completed"}</span>
      <span className={`activity-state-badge ${failed ? "is-error" : ""}`}>
        {failed ? "Error" : "Done"}
      </span>
    </div>
  );
}

function messageBlockKey(
  block: Exclude<PiContentBlockDto, { type: "text" }>,
  index: number,
): string | number {
  if (block.type === "thread-message") return block.deliveryId;
  if (block.type === "routine-invocation" || block.type === "routine-result") return block.runId;
  if (block.type === "browser-context") return block.record.contextId;
  return index;
}

function messageText(message: PiMessageDto | null): string {
  if (!message) return "";
  return message.content
    .filter((block): block is Extract<PiContentBlockDto, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function messagePresentation(row: Exclude<TranscriptRow, { kind: "tool-group" }>): {
  message: PiMessageDto | null;
  entry: import("@pippin/protocol").PiEntryDto | undefined;
  isUser: boolean;
  isAssistant: boolean;
  text: string;
  className: string;
} {
  const message = row.kind === "transient" ? row.message : row.entry.message;
  const entry = row.kind === "transient" ? undefined : row.entry;
  const isUser = message?.role === "user";
  const isAssistant = message?.role === "assistant";
  const text = messageText(message);
  const className = messageRowClass(message);
  return { message, entry, isUser, isAssistant, text, className };
}

function messageIsEmpty(message: PiMessageDto | null, hideThinking: boolean): boolean {
  if (message?.role !== "assistant" || message.errorMessage) return false;
  return !message.content.some((block) => {
    if (block.type === "tool-call") return false;
    if (block.type === "thinking") return !hideThinking && Boolean(block.text.trim());
    if (block.type === "text") return Boolean(block.text.trim());
    return true;
  });
}

function messageWithoutThinking(
  message: PiMessageDto | null,
  hideThinking: boolean,
): PiMessageDto | null {
  if (!hideThinking || !message) return message;
  return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
}

function messageActionsVisible(
  message: PiMessageDto | null,
  text: string,
  hasEntry: boolean,
): boolean {
  if (message?.role === "user") return Boolean(text) || hasEntry;
  return message?.role === "assistant" && Boolean(text);
}
