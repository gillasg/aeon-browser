import { useEffect, useState, type ReactElement, type ReactNode } from "react";

// The cursor box's quiet parts: the `/` palette (Developer options), Teach's pill,
// the working pill, the answer's receipt row and the error card. Bone and ash on obsidian; the
// only colour Graft ever adds on the page is the ochre `I'm done` of a hand-off.

export interface PaletteVerb {
  verb: "teach" | "watch" | "fill";
  label: string;
  hint: string;
}

/** Exactly three verbs: things Graft does. Going to the panel is the fixed ⌘↵ footer instead. */
export const PALETTE: readonly PaletteVerb[] = [
  { verb: "teach", label: "/teach", hint: "Show Graft how this site works" },
  { verb: "watch", label: "/watch", hint: "Tell me when something changes" },
  { verb: "fill", label: "/fill", hint: "Fill this form from my details" },
];

/** The verbs a draft like `/wa` matches; none unless the draft is a bare `/word`. */
export function paletteMatches(draft: string): PaletteVerb[] {
  if (!/^\/[a-z]*$/i.test(draft)) return [];
  const word = draft.slice(1).toLowerCase();
  return PALETTE.filter((item) => item.verb.startsWith(word));
}

/** What a verb puts in the field; Teach acts instead of prefilling. */
export function verbPrefill(verb: PaletteVerb["verb"]): string {
  if (verb === "watch") return "Tell me when ";
  if (verb === "fill") return "Fill this form from my details";
  return "";
}

export function Palette({
  draft,
  selected,
  onPick,
}: {
  draft: string;
  selected: number;
  onPick(verb: PaletteVerb["verb"]): void;
}): ReactElement | null {
  const items = paletteMatches(draft);
  if (!items.length) return null;
  return (
    <div className="isl-palette">
      <ul role="listbox" aria-label="Commands">
        {items.map((item, index) => (
          <li
            key={item.verb}
            role="option"
            aria-selected={index === selected}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item.verb);
            }}
          >
            <span className="isl-palette-verb">{item.label}</span>
            <span className="isl-palette-hint">{item.hint}</span>
          </li>
        ))}
      </ul>
      <p className="isl-palette-foot">
        <kbd>⌘↵</kbd> Open in panel
      </p>
    </div>
  );
}

/** `Teaching`, `Teaching · 3 APIs`: what Teach has picked up so far, singular for 1. */
export function teachingLabel(found: number): string {
  if (found <= 0) return "Teaching";
  return `Teaching · ${found} ${found === 1 ? "API" : "APIs"}`;
}

/** `Learned 4 APIs on example.com`, after Done. */
export function learnedLine(found: number, host: string): string {
  const apis = `${found} ${found === 1 ? "API" : "APIs"}`;
  return host ? `Learned ${apis} on ${host}` : `Learned ${apis}`;
}

/** Teach as a bottom-centre whisper pill: the page under it stays fully usable. */
export function TeachPill({ found, onDone }: { found: number; onDone(): void }): ReactElement {
  return (
    <div className="isl-teach-pill ink-wet" role="status">
      <span className="isl-teach-label">{teachingLabel(found)}</span>
      <button type="button" className="isl-teach-done" onClick={onDone}>
        Done
      </button>
      <button
        type="button"
        className="icon"
        aria-label="Stop teaching"
        title="Stop teaching"
        onClick={onDone}
      >
        <Icon d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </button>
    </div>
  );
}

/** The 2×2 micro-dot constellation: calm graduated dots at rest, a sequential wave while working. */
export function InkDots({ live = false }: { live?: boolean }): ReactElement {
  return (
    <span className="ink-dots" data-live={String(live)} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** `Working · 4s — Reading editions on Steam`: one calm line; without a start time, the phrase. */
export function workingLine(text: string, startedAt?: number, now = Date.now()): string {
  const phrase = text.replace(/\s+/g, " ").trim();
  if (startedAt === undefined) return phrase;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return phrase ? `Working · ${seconds}s — ${phrase}` : `Working · ${seconds}s`;
}

/** Working: a compact capsule, the dot wave and one single-line phrase that never wraps. */
export function WorkingPill({
  text,
  startedAt,
}: {
  text: string;
  startedAt?: number | undefined;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <p className="isl-working" role="status">
      <InkDots live />
      <span className="isl-working-text">{workingLine(text, startedAt, now)}</span>
      <span className="isl-keys" aria-hidden="true">
        <kbd>esc</kbd>
      </span>
    </p>
  );
}

export interface RunTab {
  tabId: number;
  title: string;
  host: string;
  favIconUrl?: string;
}

/**
 * Tabs the run opened and left open in the background, as quiet pills under the answer. One
 * click switches to that tab; the tab the user is on was never touched.
 */
export function RunTabPills({
  tabs,
  onJump,
}: {
  tabs: readonly RunTab[];
  onJump(tabId: number): void;
}): ReactElement | null {
  if (!tabs.length) return null;
  return (
    <ul className="isl-run-tabs" aria-label="Opened in the background">
      {tabs.map((tab) => (
        <li key={tab.tabId}>
          <button type="button" title={tab.title || tab.host} onClick={() => onJump(tab.tabId)}>
            {tab.favIconUrl && /^https?:/.test(tab.favIconUrl) ? (
              <img src={tab.favIconUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <i aria-hidden="true" />
            )}
            <span>{tab.title || tab.host}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Quiet ↑; a bone pill with an obsidian arrow once there is something to send. */
export function SendButton({
  ready,
  disabled,
  onSend,
}: {
  ready: boolean;
  disabled: boolean;
  onSend(): void;
}): ReactElement {
  return (
    <button
      type="button"
      className="isl-send"
      data-ready={String(ready)}
      title="Send"
      aria-label="Send"
      disabled={disabled}
      onClick={onSend}
    >
      <Icon d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
    </button>
  );
}

/** Hover-only, left-aligned: the finish time and an icon-only Copy. Nothing else. */
export function AnswerFoot({ time, onCopy }: { time: string; onCopy(): void }): ReactElement {
  return (
    <div className="isl-foot">
      {time ? <time className="isl-foot-time">{time}</time> : null}
      <IconButton label="Copy" onClick={onCopy} disabled={false}>
        <Icon d="M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7z" />
      </IconButton>
    </div>
  );
}

/** Error: a neutral card, the whole cause (wrapping, never cut), Retry and Open in panel. */
export function ErrorCard({
  title,
  text,
  onRetry,
  onPanel,
}: {
  title: string;
  text: string;
  onRetry?: (() => void) | undefined;
  onPanel?: (() => void) | undefined;
}): ReactElement {
  return (
    <section className="isl-error" role="alert">
      <p className="isl-error-title">{title}</p>
      {text && text !== title ? <p className="isl-error-text">{text}</p> : null}
      <div className="isl-error-actions">
        {onRetry ? (
          <button type="button" className="isl-error-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {onPanel ? (
          <button type="button" className="isl-quiet" onClick={onPanel}>
            Open in panel
          </button>
        ) : null}
      </div>
    </section>
  );
}

export interface OrbTargetChip {
  label: string;
  title: string;
}

export function TargetChip({
  target,
  onRemove,
  onHover,
}: {
  target: OrbTargetChip;
  onRemove(): void;
  onHover(on: boolean): void;
}): ReactElement {
  return (
    <span
      className="isl-chip isl-target"
      title={target.title}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <span className="isl-chip-label">{target.label}</span>
      <button
        type="button"
        className="isl-chip-x"
        aria-label={`Remove ${target.label}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      className="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Icon({ d }: { d: string }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
