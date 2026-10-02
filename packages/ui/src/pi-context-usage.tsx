import { useId, type CSSProperties, type ReactElement } from "react";
import type { PiContextUsage } from "./chat-composer.js";

export function PiContextUsageRing({ usage }: { usage: PiContextUsage | null }): ReactElement {
  const popoverId = useId();
  const { tokens, contextWindow, available, percent, known, description, style } =
    usagePresentation(usage);
  return (
    <div className="context-usage-wrap" data-known={String(known)} style={style}>
      <button
        className="context-usage-trigger"
        type="button"
        aria-label={description}
        aria-describedby={popoverId}
      >
        <span className="context-usage-ring" aria-hidden="true">
          {!known && <span>?</span>}
        </span>
      </button>
      <div
        id={popoverId}
        className="context-usage-popover"
        role="tooltip"
        aria-label="Pi context usage details"
      >
        <div className="context-usage-heading">
          <strong>{known ? `${Math.round(percent ?? 0)}% Full` : "Context usage unknown"}</strong>
          <span>
            {contextWindow !== null
              ? `${tokens === null ? "Unknown" : formatTokens(tokens)}/${formatTokens(contextWindow)} tokens`
              : "Current usage unavailable"}
          </span>
        </div>
        <dl>
          <div>
            <dt>Used</dt>
            <dd>{tokens === null ? "Unknown" : `${formatTokens(tokens)} tokens`}</dd>
          </div>
          <div>
            <dt>Available</dt>
            <dd>{available === null ? "Unknown" : `${formatTokens(available)} tokens`}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  const thousands = value / 1_000;
  const rounded = thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}K`;
}

function usagePresentation(usage: PiContextUsage | null): {
  tokens: number | null;
  contextWindow: number | null;
  available: number | null;
  percent: number | null;
  known: boolean;
  description: string;
  style: CSSProperties;
} {
  const tokens = usage?.tokens ?? null;
  const contextWindow = usage && usage.contextWindow > 0 ? usage.contextWindow : null;
  const available = usage?.availableTokens ?? null;
  const percent = contextPercent(usage, tokens, contextWindow);
  const known = percent !== null;
  const description = known
    ? `${Math.round(percent)} percent of Pi context used`
    : "Pi context usage unknown";
  const style = {
    "--context-usage-percent": `${percent ?? 0}%`,
  } as CSSProperties;

  return { tokens, contextWindow, available, percent, known, description, style };
}

function contextPercent(
  usage: PiContextUsage | null,
  tokens: number | null,
  contextWindow: number | null,
): number | null {
  const rawPercent =
    usage?.percent ?? (tokens !== null && contextWindow ? (tokens / contextWindow) * 100 : null);
  const percent =
    rawPercent !== null && Number.isFinite(rawPercent)
      ? Math.min(100, Math.max(0, rawPercent))
      : null;
  return percent;
}
