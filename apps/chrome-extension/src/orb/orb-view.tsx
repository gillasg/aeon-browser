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
  /** Tabs the first message carries as context; this tab to start with. */
  context: OrbTab[];
  /** Open tabs to add, while the + list is open. */
  tabChoices: OrbTab[] | null;
  running: ReadonlySet<string>;
  needs: ReadonlySet<string>;
}

export interface OrbTab {
  tabId: number;
  title: string;
  host: string;
  favIconUrl?: string;
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
  removeContext(tabId: number): void;
  /** Opens (or closes) the list of open tabs to add as context. */
  pickTabs(): void;
  addContext(tabId: number): void;
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
  // The field has the whole width; everything else is one quiet line under it: the tabs this
  // message carries (× drops one, + adds another), then learning and the chat switcher.
  return (
    <>
      <textarea
        id="prompt"
        rows={1}
        placeholder="Ask Aeon about this page…"
        aria-label="Ask Aeon"
        disabled={model.busy}
        onKeyDown={send}
      />
      <div className="isl-foot" data-warn={String(Boolean(model.notice))}>
        {model.context.map((tab) => (
          <ContextChip key={tab.tabId} tab={tab} actions={actions} />
        ))}
        <button
          type="button"
          className="isl-add"
          title="Add a tab"
          aria-label="Add a tab"
          aria-expanded={model.tabChoices !== null}
          onClick={actions.pickTabs}
        >
          +
        </button>
        <span className="isl-notice">{model.notice}</span>
        <LearnButton model={model} actions={actions} />
        <Switcher model={model} actions={actions} icon />
        {model.tabChoices && <TabChoices model={model} actions={actions} />}
      </div>
    </>
  );
}

function ContextChip({ tab, actions }: { tab: OrbTab; actions: OrbViewActions }): ReactElement {
  return (
    <span className="isl-chip" title={tab.title}>
      <span className="isl-chip-label">{tab.host || tab.title || "Tab"}</span>
      <button
        type="button"
        className="isl-chip-x"
        aria-label={`Remove ${tab.host || "this tab"}`}
        onClick={() => actions.removeContext(tab.tabId)}
      >
        ×
      </button>
    </span>
  );
}

function LearnButton({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  return (
    <button
      type="button"
      className="icon isl-learn"
      aria-pressed={model.learning}
      aria-label={model.learning ? "Stop learning this site" : "Learn this site"}
      title={
        model.learning
          ? `Aeon is learning ${model.host || "this site"} while you browse this tab. Click to stop.`
          : "Teach Aeon this site: it learns while you browse this tab (Chrome shows a debugger bar)"
      }
      onClick={actions.toggleLearning}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </svg>
    </button>
  );
}

/** Open tabs not already in the message, below the row (the box clips anything floating). */
function TabChoices({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const taken = new Set(model.context.map((tab) => tab.tabId));
  const tabs = (model.tabChoices ?? []).filter((tab) => !taken.has(tab.tabId));
  return (
    <ul className="isl-tabs" aria-label="Open tabs">
      {tabs.map((tab) => (
        <li key={tab.tabId}>
          <button type="button" title={tab.host} onClick={() => actions.addContext(tab.tabId)}>
            {tab.favIconUrl && /^https?:/.test(tab.favIconUrl) ? (
              <img src={tab.favIconUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <i aria-hidden="true" />
            )}
            <span>{tab.title || tab.host}</span>
          </button>
        </li>
      ))}
      {!tabs.length && <li className="isl-tabs-empty">No other tabs open.</li>}
    </ul>
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
        <Button label="New chat" onClick={actions.newChat} icon="new" />
        <Button label="Move to side panel" onClick={actions.toSidePanel} icon="panel" />
        <Button label="Open in a tab" onClick={actions.toTab} icon="tab" />
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
  icon = false,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
  label?: string;
  icon?: boolean;
}): ReactElement {
  return (
    <ChatSwitcher
      chats={model.chats}
      currentChatId={model.chatId}
      running={model.running}
      needs={model.needs}
      onSelect={actions.selectChat}
      onOpen={actions.loadChats}
      icon={icon}
      {...(label ? { label } : {})}
    />
  );
}

function titleOf(model: OrbViewModel): string {
  return model.chats.find((chat) => chat.chatId === model.chatId)?.title ?? "This chat";
}

// 16px line icons in one stroke weight, so the bar reads as one set.
const ICONS = {
  new: "M8 3.5v9M3.5 8h9",
  panel: "M3 3.5h10v9H3zM9.5 3.5v9",
  tab: "M9 3.5h3.5V7M12.5 3.5 7.5 8.5M11 9.5v3H3.5V5h3",
} as const;

function Button({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick(): void;
  icon: keyof typeof ICONS;
}): ReactElement {
  return (
    <button type="button" className="icon" title={label} aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          d={ICONS[icon]}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
