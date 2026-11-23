import { type ReactElement, type ReactNode } from "react";

// The cursor box's quiet parts: the `/` palette (Developer options), Teach's pill,
// the working pill, the answer's receipt row and the error card. Bone and ash on obsidian; the
// only colour Aeon ever adds on the page is the ochre `I'm done` of a hand-off.

export interface PaletteVerb {
  verb: "teach" | "watch" | "fill";
  label: string;
  hint: string;
}

/** Exactly three verbs: things Aeon does. Going to the panel is the fixed ⌘↵ footer instead. */
export const PALETTE: readonly PaletteVerb[] = [
  { verb: "teach", label: "/teach", hint: "Show Aeon how this site works" },
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

/** `Teaching`, `Teaching · 3 steps`: what Teach has picked up so far, singular for 1. */
export function teachingLabel(found: number): string {
  if (found <= 0) return "Teaching";
  return `Teaching · ${found} ${found === 1 ? "step" : "steps"}`;
}

/** `Learned a skill on flipkart.com · 4 steps`, after Done. */
export function learnedLine(found: number, host: string): string {
  const steps = `${found} ${found === 1 ? "step" : "steps"}`;
  return host ? `Learned a skill on ${host} · ${steps}` : `Learned a skill · ${steps}`;
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

/** `4s`, `1m 12s`. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** `0.4s`, `12s`: a finished run's one duration. */
export function durationLabel(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10
    ? `${(Math.round(seconds * 10) / 10).toFixed(1)}s`
    : `${Math.round(seconds)}s`;
}

/** Wet: one breathing-hairline pill, `◌ Reading editions on Steam · 4s   ⌘↵  esc`. */
export function WorkingPill({
  text,
  elapsed,
}: {
  text: string;
  elapsed?: string | undefined;
}): ReactElement {
  return (
    <p className="isl-working ink-wet" role="status">
      <span className="isl-working-glyph" aria-hidden="true">
        ◌
      </span>
      <span className="isl-working-text">{text}</span>
      {elapsed ? <span className="isl-working-time">· {elapsed}</span> : null}
      <span className="isl-keys" aria-hidden="true">
        <kbd>⌘↵</kbd>
        <kbd>esc</kbd>
      </span>
    </p>
  );
}

/** Dry: one non-wrapping receipt line, `0.4s · via skill`, with hover icons, never emoji. */
export function ReceiptRow({
  receipt,
  onCopy,
  onWrong,
  onRetry,
  disabled,
}: {
  receipt: string;
  onCopy(): void;
  onWrong?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="isl-receipt">
      <span className="isl-receipt-text">{receipt}</span>
      <span className="isl-receipt-icons">
        <IconButton label="Copy" onClick={onCopy} disabled={false}>
          <Icon d="M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7z" />
        </IconButton>
        {onWrong ? (
          <IconButton label="Wrong answer" onClick={onWrong} disabled={disabled}>
            <Icon d="M5.5 9V3.5h6.2a1.2 1.2 0 0 1 1.2 1l.6 3.9a1.2 1.2 0 0 1-1.2 1.4H9.5l.5 2.3a1 1 0 0 1-1.9.7L5.5 9ZM3 3.5h2.5V9H3z" />
          </IconButton>
        ) : null}
        {onRetry ? (
          <IconButton label="Retry" onClick={onRetry} disabled={disabled}>
            <Icon d="M12.5 7.5A4.5 4.5 0 1 1 11.2 4.3M12.8 2.5v2.8H10" />
          </IconButton>
        ) : null}
      </span>
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
