import { useState, type ReactElement } from "react";
import type { ChatComposerProps, ComposerControls } from "./chat-composer.js";
import { SidebarIcon } from "./sidebar-icons.js";
type Action = NonNullable<ChatComposerProps["onQueueAction"]>;
export function PiQueue(props: {
  controls: ComposerControls | null;
  onAction?: Action | undefined;
}): ReactElement | null {
  const items = [
    ...(props.controls?.steeringQueue ?? []).map((text, index) => ({
      text,
      index,
      mode: "steer" as const,
    })),
    ...(props.controls?.followUpQueue ?? []).map((text, index) => ({
      text,
      index,
      mode: "followUp" as const,
    })),
  ];
  if (!items.length) return null;
  return (
    <section className="composer-queue-list" aria-label="Queued messages" aria-live="polite">
      {items.map((item) => (
        <QueueRow
          key={item.mode + item.index + item.text}
          {...item}
          count={
            item.mode === "steer"
              ? (props.controls?.steeringQueue.length ?? 0)
              : (props.controls?.followUpQueue.length ?? 0)
          }
          onAction={props.onAction}
        />
      ))}
    </section>
  );
}
interface QueueRowProps {
  text: string;
  index: number;
  mode: "steer" | "followUp";
  count: number;
  onAction?: Action | undefined;
}
function QueueRow(props: QueueRowProps): ReactElement {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(props.text);
  const [busy, setBusy] = useState(false);
  const act = async (action: Parameters<Action>[2], value?: string): Promise<void> => {
    if (!props.onAction || busy) return;
    setBusy(true);
    try {
      await props.onAction(props.mode, props.index, action, value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer-queue-item">
      <QueueReorder {...props} busy={busy} act={act} />
      {editing ? (
        <QueueEditor
          text={text}
          onText={setText}
          busy={busy}
          cancel={() => setEditing(false)}
          save={() => {
            if (text.trim()) void act("edit", text.trim()).then(() => setEditing(false));
          }}
        />
      ) : (
        <span className="composer-queue-copy" title={props.text}>
          {props.text}
        </span>
      )}
      {!editing && (
        <QueueActions mode={props.mode} busy={busy} act={act} edit={() => setEditing(true)} />
      )}
    </div>
  );
}
type Act = (action: Parameters<Action>[2], value?: string) => Promise<void>;
function QueueReorder(props: QueueRowProps & { busy: boolean; act: Act }): ReactElement {
  return (
    <div className="queue-reorder">
      {props.count > 1 ? (
        <>
          <button
            title="Move up"
            aria-label="Move queued message up"
            disabled={props.busy || props.index === 0}
            onClick={() => void props.act("up")}
          >
            ⌃
          </button>
          <button
            title="Move down"
            aria-label="Move queued message down"
            disabled={props.busy || props.index === props.count - 1}
            onClick={() => void props.act("down")}
          >
            ⌄
          </button>
        </>
      ) : (
        <span aria-hidden="true">↳</span>
      )}
    </div>
  );
}
function QueueEditor(props: {
  text: string;
  onText(value: string): void;
  busy: boolean;
  cancel(): void;
  save(): void;
}): ReactElement {
  return (
    <form
      className="queue-edit"
      onSubmit={(event) => {
        event.preventDefault();
        props.save();
      }}
    >
      <input
        autoFocus
        aria-label="Edit queued message"
        value={props.text}
        onChange={(event) => props.onText(event.target.value)}
      />
      <button disabled={props.busy || !props.text.trim()}>Save</button>
      <button type="button" onClick={props.cancel}>
        Cancel
      </button>
    </form>
  );
}
function QueueActions(props: {
  mode: "steer" | "followUp";
  busy: boolean;
  act: Act;
  edit(): void;
}): ReactElement {
  return (
    <div className="queue-actions">
      {props.mode === "followUp" ? (
        <button disabled={props.busy} onClick={() => void props.act("steer")}>
          <span aria-hidden="true">↪</span> Steer
        </button>
      ) : (
        <span className="composer-queue-mode">Steering</span>
      )}
      <button
        disabled={props.busy}
        title="Delete queued message"
        aria-label="Delete queued message"
        onClick={() => void props.act("delete")}
      >
        <SidebarIcon kind="delete" />
      </button>
      <button
        disabled={props.busy}
        title="Edit queued message"
        aria-label="Edit queued message"
        onClick={props.edit}
      >
        <QueueEditIcon />
      </button>
    </div>
  );
}
function QueueEditIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="m15 4 5 5M4 20l4-1L20 7l-4-4L4 15z" />
    </svg>
  );
}
