import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";
import {
  piSlashCommandsKey,
  useAgentFlag,
  type AnswerFooter,
  type AnswerOffer,
  type BoxLine,
  type SiteCounts,
} from "@graft/ui";
import { AnswerInPlace, answerFits } from "./orb-answer.js";
import {
  ErrorCard,
  Palette,
  AnswerFoot,
  RunTabPills,
  SendButton,
  TargetChip,
  TeachPill,
  WorkingPill,
  paletteMatches,
  verbPrefill,
  type OrbTargetChip,
  type PaletteVerb,
  type RunTab,
} from "./orb-view-parts.js";

export type { OrbTargetChip } from "./orb-view-parts.js";

// The cursor's ask box: always a compose field. The first message starts a chat with this tab as
// context, later ones continue it; the transcript itself lives in the side panel (☰). One input
// row, no whispers or starter chips; `/` verbs only with Developer options on. Working is one breathing pill,
// an answer dries into clean text and one receipt line. Nothing promotes to the panel by itself:
// only ⌘↵, Open in panel or the toolbar does.

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
  /** What Graft knows about this site, from the registry; absent until read. Not shown in the box. */
  xray?: SiteCounts;
  /** The first few summons with no page signal show `Type / for Teach, Watch, Fill`. */
  hint?: boolean;
  /** When the current run started here, for the working pill's `· 4s`. */
  startedAt?: number;
  /** How long the finished run took; with `startedAt`, the answer's hover-only `13:47`. */
  durationMs?: number;
  /** The message this run answers, echoed muted above the answer. */
  asked?: string;
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
  /** Tabs the finished run left open in the background, one click away. */
  runTabs?: RunTab[];
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
  /** Send the last message again (the receipt's Retry, the error card's Retry). */
  retry(): void;
  /** ⌘↵: open the side panel on this chat, sending the draft there first when there is one. */
  promote(text?: string): void;
  copyAnswer(): void;
  dismissHint(): void;
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
  /** Switches to a tab the run opened in the background. */
  jumpToTab(tabId: number): void;
}

export function OrbBox({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  if (model.learning)
    return (
      <div className="island" data-state="teach">
        <TeachPill found={model.learnFound ?? 0} onDone={actions.toggleLearning} />
      </div>
    );
  return (
    <div className="island" data-state={islandState(model)}>
      <Compose model={model} actions={actions} />
    </div>
  );
}

/** compose · working · answer · error: what the box is showing, for its width and its hairline. */
export function islandState(model: OrbViewModel): "compose" | "working" | "answer" | "error" {
  const line = model.line;
  if (!line || line.text === model.ask) return "compose";
  if (line.title) return "error";
  return line.more ? "answer" : "working";
}

interface PromptKeys {
  draft: string;
  selected: number;
  matches: PaletteVerb[];
  setDraft(text: string): void;
  setSelected(index: number): void;
  prefill(text: string): void;
  pick(verb: PaletteVerb["verb"]): void;
  keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
}

/** The field's draft, the `/` palette's choice, and what each key does. */
function usePromptKeys(model: OrbViewModel, actions: OrbViewActions): PromptKeys {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  // The `/` verbs are for builders: Settings → Developer options.
  const [slash] = useAgentFlag(piSlashCommandsKey);
  const matches = slash ? paletteMatches(draft) : [];
  const prefill = (text: string): void => {
    const node = document.getElementById("prompt") as HTMLTextAreaElement | null;
    if (!node) return;
    node.value = text;
    setDraft(text);
    node.focus();
    node.setSelectionRange(text.length, text.length);
  };
  const pick = (verb: PaletteVerb["verb"]): void => {
    setSelected(0);
    prefill(verb === "teach" ? "" : verbPrefill(verb));
    if (verb === "teach") actions.toggleLearning();
  };
  const keys = { draft, selected, matches, setDraft, setSelected, prefill, pick };
  return { ...keys, keyDown: (event) => promptKey(event, keys, model, actions) };
}

function promptKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  keys: Omit<PromptKeys, "keyDown">,
  model: OrbViewModel,
  actions: OrbViewActions,
): void {
  const node = event.currentTarget;
  if (event.key === "Backspace" && !node.value && model.target) {
    event.preventDefault();
    return actions.removeTarget();
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") return paletteArrow(event, keys);
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  enter(node.value.trim(), event.metaKey || event.ctrlKey, keys, actions);
}

function paletteArrow(
  event: KeyboardEvent<HTMLTextAreaElement>,
  keys: Omit<PromptKeys, "keyDown">,
): void {
  const count = keys.matches.length;
  if (!count) return;
  event.preventDefault();
  keys.setSelected((keys.selected + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
}

/** ⌘↵ promotes to the panel; ↵ picks the highlighted verb, else sends. */
function enter(
  text: string,
  promote: boolean,
  keys: Omit<PromptKeys, "keyDown">,
  actions: OrbViewActions,
): void {
  const verb = keys.matches[Math.min(keys.selected, keys.matches.length - 1)];
  if (promote) {
    keys.setDraft("");
    return actions.promote(text || undefined);
  }
  if (verb) return keys.pick(verb.verb);
  if (!text) return;
  keys.setDraft("");
  actions.submit(text);
}

function Compose({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const keys = usePromptKeys(model, actions);
  // The box opens with the caret in the field, so typing goes here and never scrolls the page.
  useEffect(() => {
    (document.getElementById("prompt") as HTMLTextAreaElement | null)?.focus();
  }, []);
  return (
    <>
      {model.ask && <p className="isl-ask">{model.ask}</p>}
      <RunningLine model={model} actions={actions} />
      <ContextLead model={model} actions={actions} />
      <div className="isl-input" data-warn={String(Boolean(model.notice))}>
        <AddTab model={model} actions={actions} />
        <textarea
          id="prompt"
          rows={1}
          placeholder={promptPlaceholder(model)}
          aria-label="Ask Graft"
          disabled={model.busy}
          onKeyDown={keys.keyDown}
          onInput={(event) => {
            keys.setDraft(event.currentTarget.value);
            keys.setSelected(0);
          }}
        />
        <Trail model={model} actions={actions} />
        <SendButton
          ready={Boolean(keys.draft.trim())}
          disabled={model.busy}
          onSend={() => enter(keys.draft.trim(), false, keys, actions)}
        />
      </div>
      {keys.matches.length > 0 && (
        <Palette draft={keys.draft} selected={keys.selected} onPick={keys.pick} />
      )}
      {model.learned ? <p className="isl-learned">{model.learned}</p> : null}
    </>
  );
}

/** The `@ site` context chips and the pointed-at element: a cap above the input row. */
function ContextLead({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement | null {
  if (!model.target && !model.context.length) return null;
  return (
    <div className="isl-context">
      {model.context.map((tab) => (
        <ContextChip key={tab.tabId} tab={tab} actions={actions} />
      ))}
      {model.target ? (
        <TargetChip
          target={model.target}
          onRemove={actions.removeTarget}
          onHover={actions.hoverTarget}
        />
      ) : null}
    </div>
  );
}

/** The leading + sits on the input's own centerline: no separate footer strip. */
function AddTab({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  return (
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
  );
}

/** Trailing controls on the same row as the field; the tab list wraps below it. */
function Trail({ model, actions }: { model: OrbViewModel; actions: OrbViewActions }): ReactElement {
  return (
    <>
      {model.notice ? <span className="isl-notice">{model.notice}</span> : null}
      {islandState(model) === "answer" ? null : (
        <Button label="Open in Side Panel" onClick={() => actions.promote()} icon="panel" />
      )}
      {model.tabChoices && <TabChoices model={model} actions={actions} />}
    </>
  );
}

function promptPlaceholder(model: OrbViewModel): string {
  if (model.ask) return "Type the answer here…";
  if (model.chatId) return "Reply…";
  // Graft's own pages are never page context. Never an inventory count here.
  const host = model.context[0]?.host || model.host;
  return model.context.length && host ? `Ask about ${host}` : "Ask…";
}

function RunningLine({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement | null {
  const state = islandState(model);
  const line = model.line;
  if (!line || state === "compose") return null;
  if (state === "working") return <WorkingPill text={line.text} startedAt={model.startedAt} />;
  if (state === "error")
    return (
      <ErrorCard
        title={line.title ?? "Couldn't finish"}
        text={line.text}
        onRetry={model.busy ? undefined : actions.retry}
        onPanel={model.chatId ? actions.toSidePanel : undefined}
      />
    );
  // A finished answer short enough to read here shows whole; a long one stays clamped and
  // waits for ⌘↵. It never moves to the panel on its own.
  const inPlace = answerFits(line.text);
  return (
    <>
      <div className="isl-echo">
        <span className="isl-echo-text">{model.asked ?? ""}</span>
        <Button label="Open in Side Panel" onClick={actions.toSidePanel} icon="panel" />
      </div>
      {inPlace ? (
        <AnswerInPlace text={line.text} />
      ) : (
        <div className="isl-line">
          <AnswerInPlace text={line.text} clamp />
          <button type="button" className="isl-line-more" onClick={actions.toSidePanel}>
            <kbd>⌘↵</kbd> Continue in panel
          </button>
        </div>
      )}
      <RunTabPills tabs={model.runTabs ?? []} onJump={actions.jumpToTab} />
      <AnswerFoot time={finishedAt(model)} onCopy={actions.copyAnswer} />
    </>
  );
}

/** `13:47`: when the run finished, local time. Never how long it took. */
export function finishedAt(model: Pick<OrbViewModel, "startedAt" | "durationMs">): string {
  if (model.startedAt === undefined || model.durationMs === undefined) return "";
  const at = new Date(model.startedAt + model.durationMs);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function ContextChip({ tab, actions }: { tab: OrbTab; actions: OrbViewActions }): ReactElement {
  return (
    <span className="isl-chip" title={tab.title}>
      <span className="isl-chip-label">
        <span className="isl-chip-at" aria-hidden="true">
          @{" "}
        </span>
        {tab.host || tab.title || "Tab"}
      </span>
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

// 16px line icons in one stroke weight, so the bar reads as one set.
const ICONS = {
  // ☰: the same three lines as the working pill's transcript button.
  panel: "M3 4.5h10M3 8h10M3 11.5h10",
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
