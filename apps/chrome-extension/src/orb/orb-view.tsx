import type { KeyboardEvent, ReactElement } from "react";
import { ChatSwitcher, type BoxLine } from "@aeon/ui";

// The cursor's ask box: always a compose field. The first message starts a chat with this tab as
// context, later ones continue it; the transcript itself lives in the side panel (☰).

export interface OrbViewModel {
  host: string;
  /** The chat this orb started, once the first message is sent. */
  chatId: string | undefined;
  notice: string;
  /** The chat asks the user something: the question, answered by typing here (or in the side panel). */
  ask: string;
  busy: boolean;
  /** This tab records the site's requests while the user browses ("Learn this site"). */
  learning: boolean;
  chats: { chatId: string; title: string; updatedAt: string }[];
  /** Tabs the first message carries as context; this tab to start with. */
  context: OrbTab[];
  /** Open tabs to add, while the + list is open. */
  tabChoices: OrbTab[] | null;
  running: ReadonlySet<string>;
  needs: ReadonlySet<string>;
  /** The step, or the answer once the run ends. Absent before a run. */
  line?: BoxLine;
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
  /** The transcript, in the side panel beside this page. */
  toSidePanel(): void;
  toggleLearning(): void;
  removeContext(tabId: number): void;
  /** Opens (or closes) the list of open tabs to add as context. */
  pickTabs(): void;
  addContext(tabId: number): void;
}

export function OrbBox({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  return (
    <div className="island" data-state="compose">
      <Compose model={model} actions={actions} />
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
      {model.ask && <p className="isl-ask">{model.ask}</p>}
      <RunningLine model={model} actions={actions} />
      <textarea
        id="prompt"
        rows={1}
        placeholder={promptPlaceholder(model)}
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
        {model.chatId && (
          <Button
            label="Open the transcript in the side panel"
            onClick={actions.toSidePanel}
            icon="panel"
          />
        )}
        {model.chatId && <Button label="New chat" onClick={actions.newChat} icon="new" />}
        <Switcher model={model} actions={actions} icon />
        {model.tabChoices && <TabChoices model={model} actions={actions} />}
      </div>
    </>
  );
}

function promptPlaceholder(model: OrbViewModel): string {
  if (model.ask) return "Type the answer here…";
  if (model.chatId) return "Reply to Aeon…";
  return "Ask Aeon about this page…";
}

function RunningLine({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement | null {
  const line = model.line;
  if (!line || line.text === model.ask) return null;
  return (
    <p className="isl-line">
      {line.title ? <span className="isl-line-title">{line.title}</span> : null}
      <span className="isl-line-text" data-clamp={line.more ? "2" : "1"}>
        {line.text}
      </span>
      {line.more ? (
        <button type="button" className="isl-line-more" onClick={actions.toSidePanel}>
          Side panel
        </button>
      ) : null}
    </p>
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

function Switcher({
  model,
  actions,
  icon = false,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
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
    />
  );
}

// 16px line icons in one stroke weight, so the bar reads as one set.
const ICONS = {
  new: "M8 3.5v9M3.5 8h9",
  panel: "M3 3.5h10v9H3zM9.5 3.5v9",
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
