import { useState, type KeyboardEvent, type ReactElement } from "react";
import {
  AnswerLines,
  ChatSwitcher,
  type AnswerFooter,
  type AnswerOffer,
  type BoxLine,
  type SiteCounts,
} from "@aeon/ui";
import { AnswerInPlace, answerFits } from "./orb-answer.js";
import {
  PowerRow,
  TargetChip,
  TeachControl,
  XrayStrip,
  type OrbTargetChip,
} from "./orb-view-parts.js";

export type { OrbTargetChip } from "./orb-view-parts.js";

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
  /** This tab records the site's requests while the user browses (Teach). */
  learning: boolean;
  /** Distinct APIs the current teaching session mapped. */
  learnFound?: number;
  /** `Learned 4 APIs on flipkart.com`, for a few seconds after Done. */
  learned?: string;
  /** What Aeon knows about this site, from the registry; absent until read. */
  xray?: SiteCounts;
  /** The page has a form worth filling (3 or more visible, enabled fields). */
  fillForm?: boolean;
  /** What the pointer was on, or the selection, when the cursor was summoned. */
  target?: OrbTargetChip;
  chats: { chatId: string; title: string; updatedAt: string }[];
  /** Tabs the first message carries as context; this tab to start with. */
  context: OrbTab[];
  /** Open tabs to add, while the + list is open. */
  tabChoices: OrbTab[] | null;
  running: ReadonlySet<string>;
  needs: ReadonlySet<string>;
  /** The step, or the answer once the run ends. Absent before a run. */
  line?: BoxLine;
  /** Learned line, speed line and offers under a finished answer. */
  footer?: AnswerFooter;
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
  answerOffer(offer: AnswerOffer): void;
  answerWrong(): void;
  toggleLearning(): void;
  removeContext(tabId: number): void;
  /** Opens (or closes) the list of open tabs to add as context. */
  pickTabs(): void;
  addContext(tabId: number): void;
  /** Opens the Manage tab, at a route like `#sites?host=…`. */
  openManage(route?: string): void;
  removeTarget(): void;
  /** Shows the pointed-at element's outline on the page again, while the chip is hovered. */
  hoverTarget(on: boolean): void;
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
  const [empty, setEmpty] = useState(true);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const field = event.currentTarget;
    if (event.key === "Backspace" && !field.value && model.target) {
      event.preventDefault();
      actions.removeTarget();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    setEmpty(true);
    actions.submit(text);
  };
  const prefill = (text: string): void => {
    const field = document.getElementById("prompt") as HTMLTextAreaElement | null;
    if (!field) return;
    field.value = text;
    setEmpty(false);
    field.focus();
    field.setSelectionRange(text.length, text.length);
  };
  // The field has the whole width; everything else is one quiet line under it: the tabs this
  // message carries (× drops one, + adds another), then Teach and the chat switcher.
  return (
    <>
      <XrayStrip
        host={model.host}
        counts={model.xray}
        onOpen={(host) => actions.openManage("#sites?host=" + encodeURIComponent(host))}
      />
      {model.ask && <p className="isl-ask">{model.ask}</p>}
      <RunningLine model={model} actions={actions} />
      <textarea
        id="prompt"
        rows={1}
        placeholder={promptPlaceholder(model)}
        aria-label="Ask Aeon"
        disabled={model.busy}
        onKeyDown={keyDown}
        onInput={(event) => setEmpty(!event.currentTarget.value)}
      />
      {empty && !model.chatId && !model.ask ? (
        <PowerRow fillForm={model.fillForm === true} onPrefill={prefill} />
      ) : null}
      {model.learned ? <p className="isl-learned">{model.learned}</p> : null}
      <Foot model={model} actions={actions} />
    </>
  );
}

function Foot({ model, actions }: { model: OrbViewModel; actions: OrbViewActions }): ReactElement {
  return (
    <div className="isl-foot" data-warn={String(Boolean(model.notice))}>
      {model.target ? (
        <TargetChip
          target={model.target}
          onRemove={actions.removeTarget}
          onHover={actions.hoverTarget}
        />
      ) : null}
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
      <TeachControl
        learning={model.learning}
        found={model.learnFound ?? 0}
        onToggle={actions.toggleLearning}
      />
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
  );
}

function promptPlaceholder(model: OrbViewModel): string {
  if (model.ask) return "Type the answer here…";
  if (model.chatId) return "Reply to Aeon…";
  // Aeon's own pages are never page context.
  return model.context.length ? "Ask Aeon about this page…" : "Ask Aeon anything…";
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
  // A finished answer short enough to read here shows whole; an error or a long one stays clamped.
  const inPlace = line.more && !line.title && answerFits(line.text);
  return (
    <>
      {inPlace ? (
        <AnswerInPlace text={line.text} />
      ) : (
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
      )}
      {line.more && model.footer ? (
        <AnswerLines
          footer={model.footer}
          disabled={model.busy}
          onOffer={actions.answerOffer}
          onWrong={actions.answerWrong}
        />
      ) : null}
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
      onManage={() => actions.openManage()}
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
