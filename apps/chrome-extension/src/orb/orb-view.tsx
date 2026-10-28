import type { KeyboardEvent, ReactElement } from "react";

// The orb's box. Before a chat exists it is a compose field; after, it is the same chat the side
// panel and the chat tab show (chat.html, framed), with hand-off buttons. One component, three sizes.

export interface OrbViewModel {
  host: string;
  /** The chat this orb started, once the first message is sent. */
  chatId: string | undefined;
  /** The chat page to frame (chat.html for chatId), built by the page that owns chrome APIs. */
  chatUrl: string;
  notice: string;
  busy: boolean;
  /** This tab records the site's requests while the user browses ("Learn this site"). */
  learning: boolean;
}

export interface OrbViewActions {
  submit(text: string): void;
  /** Fold the chat away; the orb stays with a pill under it while the run goes on. */
  minimize(): void;
  close(): void;
  toSidePanel(): void;
  toTab(): void;
  toggleLearning(): void;
}

export type BoxState = "compose" | "chat";

export function boxState(model: Pick<OrbViewModel, "chatId">): BoxState {
  return model.chatId ? "chat" : "compose";
}

export function OrbBox({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const state = boxState(model);
  return (
    <div className="island" data-state={state}>
      {state === "compose" ? (
        <Compose model={model} actions={actions} />
      ) : (
        <ChatBox model={model} actions={actions} />
      )}
    </div>
  );
}

function Compose({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const send = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const text = event.currentTarget.value.trim();
    if (text) actions.submit(text);
  };
  return (
    <>
      <div className="isl-row">
        <textarea
          id="prompt"
          rows={1}
          placeholder="Ask Aeon to do something on this page…"
          aria-label="Ask Aeon"
          disabled={model.busy}
          onKeyDown={send}
        />
        <Button kind="icon" label="Minimize (Esc)" onClick={actions.minimize}>
          ⌄
        </Button>
        <Button kind="icon" label="Close" onClick={actions.close}>
          ✕
        </Button>
      </div>
      <div className="isl-hint" data-warn={String(Boolean(model.notice))}>
        <span>{model.notice || "Enter to send · Esc to close"}</span>
        <button
          type="button"
          className="isl-chip isl-learn"
          aria-pressed={model.learning}
          title={
            model.learning
              ? "Aeon is learning this site's API while you browse this tab. Click to stop."
              : "Learn this site's API while you browse this tab (Chrome shows a debugger bar)"
          }
          onClick={actions.toggleLearning}
        >
          {model.learning ? `Learning ${model.host || "this site"}` : model.host || "This page"}
        </button>
      </div>
    </>
  );
}

/** The chat itself, framed, under a slim bar that moves it to the side panel or a tab. */
function ChatBox({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  return (
    <>
      <div className="box-bar">
        <span className="box-title">{model.notice || model.host || "Aeon"}</span>
        <Button kind="icon" label="Move to side panel" onClick={actions.toSidePanel}>
          ⇱
        </Button>
        <Button kind="icon" label="Open in a tab" onClick={actions.toTab}>
          ↗
        </Button>
        <Button kind="icon" label="Minimize (Esc)" onClick={actions.minimize}>
          ⌄
        </Button>
        <Button kind="icon" label="Close" onClick={actions.close}>
          ✕
        </Button>
      </div>
      <iframe className="box-chat" title="Aeon chat" src={model.chatUrl} />
    </>
  );
}

function Button({
  kind = "ghost",
  label,
  onClick,
  children,
}: {
  kind?: "primary" | "ghost" | "icon";
  label?: string;
  onClick(): void;
  children: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={kind}
      title={label}
      aria-label={kind === "icon" ? label : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
