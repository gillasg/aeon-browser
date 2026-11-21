import { Fragment, type ReactElement } from "react";
import { xrayParts, type SiteCounts } from "@aeon/ui";

// The cursor box's quiet rows: the X-Ray strip (what Aeon knows about this site), the prefill
// line under an empty prompt, the Teach control, and the pointed-at element's chip.

/** `4 APIs · 1 boost · 1 watch`; no element at all when every count is 0. */
export function XrayStrip({
  host,
  counts,
  onOpen,
}: {
  host: string;
  counts: SiteCounts | undefined;
  onOpen(host: string): void;
}): ReactElement | null {
  const parts = xrayParts(counts);
  if (!host || !parts.length) return null;
  return (
    <button
      type="button"
      className="isl-xray"
      aria-label={`What Aeon knows about ${host}`}
      onClick={() => onOpen(host)}
    >
      {parts.map((part, index) => (
        <Fragment key={part.noun}>
          {index ? <span className="isl-xray-sep"> · </span> : null}
          <span className="isl-xray-num">{part.count}</span> {part.noun}
        </Fragment>
      ))}
    </button>
  );
}

export interface PowerItem {
  label: string;
  prefill: string;
}

/** Prompt starters, not actions: a click fills the prompt and never sends. */
export function powerItems(fillForm: boolean): PowerItem[] {
  return [
    { label: "Boost this site", prefill: "Change this site so that " },
    { label: "Watch", prefill: "Tell me when " },
    ...(fillForm ? [{ label: "Fill form", prefill: "Fill this form from my details" }] : []),
  ];
}

export function PowerRow({
  fillForm,
  onPrefill,
}: {
  fillForm: boolean;
  onPrefill(text: string): void;
}): ReactElement {
  return (
    <p className="isl-power">
      {powerItems(fillForm).map((item, index) => (
        <Fragment key={item.label}>
          {index ? <span className="isl-power-sep"> · </span> : null}
          <button type="button" onClick={() => onPrefill(item.prefill)}>
            {item.label}
          </button>
        </Fragment>
      ))}
    </p>
  );
}

/** `● Teaching`, `● Teaching · 3 APIs`: distinct APIs found, singular for 1. */
export function teachingLabel(found: number): string {
  if (found <= 0) return "Teaching";
  return `Teaching · ${found} ${found === 1 ? "API" : "APIs"}`;
}

/** `Learned 4 APIs on flipkart.com`, after Done. */
export function learnedLine(found: number, host: string): string {
  const noun = found === 1 ? "API" : "APIs";
  return host ? `Learned ${found} ${noun} on ${host}` : `Learned ${found} ${noun}`;
}

export function TeachControl({
  learning,
  found,
  onToggle,
}: {
  learning: boolean;
  found: number;
  onToggle(): void;
}): ReactElement {
  if (!learning)
    return (
      <button
        type="button"
        className="isl-teach"
        title="Teach Aeon this site: it learns while you browse this tab (Chrome shows a debugger bar)"
        onClick={onToggle}
      >
        Teach
      </button>
    );
  return (
    <span className="isl-teach" data-on="true" role="status">
      <i className="isl-rec" aria-hidden="true" />
      <span className="isl-teach-label">{teachingLabel(found)}</span>
      <button type="button" className="isl-teach-stop" onClick={onToggle}>
        {found > 0 ? "Done" : "Stop"}
      </button>
    </span>
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
