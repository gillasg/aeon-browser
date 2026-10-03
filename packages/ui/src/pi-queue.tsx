import { useState, type ReactElement } from "react";
import type { ChatComposerProps, ComposerControls } from "./chat-composer.js";
import { SidebarIcon } from "./sidebar-icons.js";
type Action = NonNullable<ChatComposerProps["onQueueAction"]>;
export function PiQueue(props: { controls: ComposerControls | null; onAction?: Action | undefined }): ReactElement | null {
  const items = [
    ...(props.controls?.steeringQueue ?? []).map((text, index) => ({ text, index, mode: "steer" as const })),
    ...(props.controls?.followUpQueue ?? []).map((text, index) => ({ text, index, mode: "followUp" as const })),
  ];
  if (!items.length) return null;
  return <section className="composer-queue-list" aria-label="Queued messages" aria-live="polite">
    {items.map((item) => <QueueRow key={item.mode + item.index + item.text} {...item}
      count={item.mode === "steer" ? (props.controls?.steeringQueue.length ?? 0) : (props.controls?.followUpQueue.length ?? 0)}
      onAction={props.onAction} />)}
  </section>;
}
function QueueRow(props: { text: string; index: number; mode: "steer" | "followUp"; count: number; onAction?: Action | undefined }): ReactElement {
  const [editing, setEditing] = useState(false), [text, setText] = useState(props.text);
  const [busy, setBusy] = useState(false);
  const act = async (action: Parameters<Action>[2], value?: string): Promise<void> => {
    if (!props.onAction || busy) return;
    setBusy(true);
    try { await props.onAction(props.mode, props.index, action, value); }
    finally { setBusy(false); }
  };
  return <div className="composer-queue-item">
    <div className="queue-reorder">
      {props.count > 1 ? <>
        <button title="Move up" aria-label="Move queued message up" disabled={busy || props.index === 0} onClick={() => void act("up")}>⌃</button>
        <button title="Move down" aria-label="Move queued message down" disabled={busy || props.index === props.count - 1} onClick={() => void act("down")}>⌄</button>
      </> : <span aria-hidden="true">↳</span>}
    </div>
    {editing ? <form className="queue-edit" onSubmit={(event) => {
      event.preventDefault(); if (text.trim()) void act("edit", text.trim()).then(() => setEditing(false));
    }}><input autoFocus aria-label="Edit queued message" value={text} onChange={(event) => setText(event.target.value)} />
      <button disabled={busy || !text.trim()}>Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></form>
      : <span className="composer-queue-copy" title={props.text}>{props.text}</span>}
    {!editing && <div className="queue-actions">
      {props.mode === "followUp" ? <button disabled={busy} onClick={() => void act("steer")}><span aria-hidden="true">↪</span> Steer</button>
        : <span className="composer-queue-mode">Steering</span>}
      <button disabled={busy} title="Delete queued message" aria-label="Delete queued message" onClick={() => void act("delete")}><SidebarIcon kind="delete" /></button>
      <button disabled={busy} title="Edit queued message" aria-label="Edit queued message" onClick={() => setEditing(true)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m15 4 5 5M4 20l4-1L20 7l-4-4L4 15z" /></svg></button>
    </div>}
  </div>;
}
