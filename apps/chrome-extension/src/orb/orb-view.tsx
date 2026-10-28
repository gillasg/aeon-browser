import type { KeyboardEvent, ReactElement } from "react";
import { ChatSwitcher } from "@aeon/ui";

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
  /** The message just sent, shown at once while the chat is created and framed. */
  pending: string;
  chats: { chatId: string; title: string; updatedAt: string }[];
  running: ReadonlySet<string>;
  needs: ReadonlySet<string>;
}

export interface OrbViewActions {
  submit(text: string): void;
  /** Fold the chat away; the orb stays with a pill under it while the run goes on. */
  minimize(): void;
  selectChat(chatId: string): void;
  newChat(): void;
  loadChats(): void;
  /** The framed chat finished loading: the pending message can go. */
  chatShown(): void;
  toSidePanel(): void;
  toTab(): void;
  toggleLearning(): void;
}

export type BoxState = "compose" | "chat";

export function boxState(model: Pick<OrbViewModel, "chatId" | "pending">): BoxState {
  return model.chatId || model.pending ? "chat" : "compose";
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
        <Switcher model={model} actions={actions} label="Chats" />
        <Button kind="icon" label="Minimize (Esc)" onClick={actions.minimize}>
          ⌄
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
              ? "Aeon is learning this site while you browse this tab. Click to stop."
              : "Teach Aeon this site: it learns while you browse this tab (Chrome shows a debugger bar)"
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
        <Switcher model={model} actions={actions} label={titleOf(model)} />
        <span className="box-title">{model.notice}</span>
        <Button kind="icon" label="New chat" onClick={actions.newChat}>
          +
        </Button>
        <Button kind="icon" label="Move to side panel" onClick={actions.toSidePanel}>
          ⇱
        </Button>
        <Button kind="icon" label="Open in a tab" onClick={actions.toTab}>
          ↗
        </Button>
        <Button kind="icon" label="Minimize (Esc)" onClick={actions.minimize}>
          ⌄
        </Button>
      </div>
      <div className="box-body">
        {model.chatUrl && (
          <iframe
            className="box-chat"
            title="Aeon chat"
            src={model.chatUrl}
            onLoad={actions.chatShown}
          />
        )}
        {model.pending && (
          <div className="box-pending" aria-live="polite">
            <p className="box-pending-message">{model.pending}</p>
            <p className="box-pending-status">Starting…</p>
          </div>
        )}
      </div>
    </>
  );
}

function Switcher({
  model,
  actions,
  label,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
  label: string;
}): ReactElement {
  return (
    <ChatSwitcher
      chats={model.chats}
      currentChatId={model.chatId}
      running={model.running}
      needs={model.needs}
      onSelect={actions.selectChat}
      onOpen={actions.loadChats}
      label={label}
    />
  );
}

function titleOf(model: OrbViewModel): string {
  return model.chats.find((chat) => chat.chatId === model.chatId)?.title ?? "This chat";
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
