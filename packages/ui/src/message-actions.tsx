import { useState, type ReactElement } from "react";
import type { PiEntryDto, PiMessageDto } from "@aeon/protocol";
import { copyTextToClipboard } from "./clipboard.js";

export interface MessageActionProps {
  message: PiMessageDto | null;
  entry?: PiEntryDto | undefined;
  onEditEntry?: ((entryId: string) => Promise<void> | void) | undefined;
  onBranchEntry?: ((entryId: string) => Promise<void> | void) | undefined;
  onPin?: ((text: string) => Promise<void> | void) | undefined;
  actionsDisabled: boolean;
  text: string;
}

export function MessageActions(props: MessageActionProps): ReactElement {
  const isUser = props.message?.role === "user";
  return (
    <div className={`message-actions ${isUser ? "for-user" : "for-assistant"}`}>
      {isUser && <MessageTime entry={props.entry} />}
      <CopyAction text={props.text} isUser={isUser} />
      {!isUser && <PinAction text={props.text} onPin={props.onPin} />}
      <RoleAction props={props} isUser={isUser} />
      {!isUser && <MessageTime entry={props.entry} />}
    </div>
  );
}

/** Edit for a user message, branch for an assistant one. */
function RoleAction({
  props,
  isUser,
}: {
  props: MessageActionProps;
  isUser: boolean;
}): ReactElement | null {
  if (isUser)
    return props.entry && props.onEditEntry ? (
      <EntryAction
        kind="edit"
        entryId={props.entry.entryId}
        action={props.onEditEntry}
        disabled={props.actionsDisabled}
      />
    ) : null;
  return props.entry && props.onBranchEntry ? (
    <EntryAction
      kind="branch"
      entryId={props.entry.entryId}
      action={props.onBranchEntry}
      disabled={props.actionsDisabled}
    />
  ) : null;
}

function CopyAction({ text, isUser }: { text: string; isUser: boolean }): ReactElement | null {
  const [state, setState] = useState<"Copy" | "Copied" | "Copy failed">("Copy");
  if (!text.trim()) return null;
  const copy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(text.trim());
      setState("Copied");
    } catch {
      setState("Copy failed");
    }
  };
  return (
    <button
      type="button"
      className="message-copy"
      aria-label={`Copy ${isUser ? "user" : "assistant"} message`}
      title={state === "Copy" ? "Copy message" : state}
      onClick={() => void copy()}
    >
      {state === "Copied" || state === "Copy failed" ? (
        <span className="message-copy-state">{state}</span>
      ) : (
        <CopyIcon />
      )}
    </button>
  );
}

function CopyIcon(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="7" y="6" width="9" height="11" rx="1.5" />
      <path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H7" />
    </svg>
  );
}

function PinAction({
  text,
  onPin,
}: {
  text: string;
  onPin?: ((text: string) => Promise<void> | void) | undefined;
}): ReactElement | null {
  const [state, setState] = useState<"Pin" | "Pinned" | "Pin failed">("Pin");
  if (!onPin || !text.trim()) return null;
  const run = async (): Promise<void> => {
    try {
      await onPin(text.trim());
      setState("Pinned");
    } catch {
      setState("Pin failed");
    }
  };
  return (
    <button
      type="button"
      className="message-copy message-pin"
      aria-label="Pin answer to home"
      title={state === "Pin" ? "Keep this answer on the new-tab home" : state}
      onClick={() => void run()}
    >
      {state === "Pin failed" ? <span className="message-copy-state">{state}</span> : null}
      <PinIcon pinned={state === "Pinned"} />
    </button>
  );
}

function PinIcon({ pinned }: { pinned: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {pinned ? (
        <path d="m4.5 10.5 3.5 3.5 7.5-8" />
      ) : (
        <path d="M12.5 3.5 16.5 7.5 13.5 9 11 14 6 9l5-2.5zM8.5 11.5 4 16" />
      )}
    </svg>
  );
}

function EntryAction({
  kind,
  entryId,
  action,
  disabled,
}: {
  kind: "edit" | "branch";
  entryId: string;
  action(entryId: string): Promise<void> | void;
  disabled: boolean;
}): ReactElement {
  const [pending, setPending] = useState(false);
  const run = async (): Promise<void> => {
    if (pending || disabled) return;
    setPending(true);
    try {
      await action(entryId);
    } finally {
      setPending(false);
    }
  };
  const label = kind === "edit" ? "Edit" : "Branch";
  const pendingLabel = kind === "edit" ? "Editing…" : "Branching…";
  return (
    <button
      type="button"
      className={`message-action-link message-${kind}`}
      aria-label={kind === "edit" ? "Edit message" : "Branch from response"}
      disabled={disabled || pending}
      title={
        disabled
          ? `Wait for Pi to finish before ${kind === "edit" ? "editing" : "branching"}.`
          : label
      }
      onClick={() => void run()}
    >
      {pending ? (
        pendingLabel
      ) : (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          {kind === "edit" ? (
            <>
              <path d="m13 3 4 4-9 9H4v-4zM11 5l4 4" />
            </>
          ) : (
            <>
              <path d="M10 17V9m0 0L4 3m6 6 6-6M4 3v4m0-4h4m8 0v4m0-4h-4" />
            </>
          )}
        </svg>
      )}
    </button>
  );
}

function MessageTime({ entry }: { entry?: PiEntryDto | undefined }): ReactElement | null {
  if (!entry) return null;
  const timestamp = new Date(entry.timestamp);
  if (!Number.isFinite(timestamp.valueOf())) return null;
  const formatted = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
  const full = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
  return (
    <time className="message-time" dateTime={timestamp.toISOString()} title={full}>
      {formatted}
    </time>
  );
}
