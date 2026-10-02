import { ToolReadFile } from "./tool-read-file.js";
import { FileLink } from "./file-links.js";
import type { ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";
import { isShellTool } from "./chat-activity-summary.js";

export function ToolResultView({
  step,
  compact = false,
}: {
  step: ToolStep;
  compact?: boolean;
}): ReactElement {
  if (step.resultUnavailable)
    return (
      <p className="activity-result-note">Pi did not retain a result body for this nested call.</p>
    );
  const value = step.result || step.partialResult;
  if (!value) return <></>;
  if (isReadFile(step)) return <ToolReadFile step={step} text={value} />;
  const structured = !step.isError ? structuredItems(value) : undefined;
  if (structured)
    return (
      <StructuredResult
        items={structured}
        raw={value}
        compactRows={/(?:web.*search|search.*web|history)/i.test(step.toolName)}
      />
    );
  const label = resultLabel(step);
  const outputClass = isShellTool(step.toolName) ? "step-detail shell-output" : "step-detail";
  return (
    <>
      {!compact && <p className="step-detail-label">{label}</p>}
      <pre
        className={`${outputClass} ${step.isError ? "tool-error-output" : ""}`}
        aria-label={label}
      >
        {value}
      </pre>
    </>
  );
}

function StructuredResult({
  items,
  raw,
  compactRows,
}: {
  items: readonly Record<string, unknown>[];
  raw: string;
  compactRows: boolean;
}): ReactElement {
  return (
    <section
      className={`structured-tool-result${compactRows ? " is-compact-links" : ""}`}
      aria-label="Tool result list"
    >
      <div className="structured-result-list" role="list">
        {items.slice(0, 20).map((item, index) => (
          <StructuredResultRow key={index} item={item} compact={compactRows} />
        ))}
      </div>
      {items.length > 20 && (
        <p className="structured-result-more">Showing 20 of {items.length} returned items</p>
      )}
      <details className="activity-raw-details">
        <summary>Raw output</summary>
        <pre className="step-detail">{raw}</pre>
      </details>
    </section>
  );
}

type RowFields = {
  title: string;
  side: string | undefined;
  detail: string | undefined;
  favicon: string | undefined;
  fallbackLetter: string;
};

function resolveRowFields(item: Record<string, unknown>, compact: boolean): RowFields {
  const title =
    firstString(item, "title", "name", "label", "path", "url", "hostname", "domain") ?? "Result";
  const url = firstString(item, "url", "href");
  const hostname = firstString(item, "domain", "hostname") ?? domain(url);
  const time = firstString(item, "time", "timestamp");
  const side = compact
    ? [hostname, time].filter(Boolean).join(" ")
    : (firstString(item, "domain", "hostname", "time", "timestamp") ?? domain(url));
  const detail = firstString(item, "description", "snippet", "text", "summary");
  const favicon = safeFavicon(firstString(item, "faviconUrl", "favicon_url", "favicon", "iconUrl"));
  const fallbackLetter = (hostname ?? title).trim().slice(0, 1).toUpperCase();
  return { title, side, detail, favicon, fallbackLetter };
}

function StructuredResultRow({
  item,
  compact,
}: {
  item: Record<string, unknown>;
  compact: boolean;
}): ReactElement {
  const { title, side, detail, favicon, fallbackLetter } = resolveRowFields(item, compact);
  return (
    <div className={`structured-result-row${compact ? " is-compact-link" : ""}`} role="listitem">
      {compact && (
        <span className="structured-result-favicon" aria-hidden="true">
          {fallbackLetter}
          {favicon && (
            <img src={favicon} alt="" onError={(event) => event.currentTarget.remove()} />
          )}
        </span>
      )}
      <div className="structured-result-copy">
        <span className="structured-result-title">
          {firstString(item, "path", "filePath", "file_path") ? (
            <FileLink path={firstString(item, "path", "filePath", "file_path") ?? title}>
              {bounded(title)}
            </FileLink>
          ) : (
            bounded(title)
          )}
        </span>
        {!compact && detail && <span className="structured-result-detail">{bounded(detail)}</span>}
      </div>
      {side && <span className="structured-result-side">{bounded(side)}</span>}
    </div>
  );
}

function structuredItems(value: string): Record<string, unknown>[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return resultRecords(parsed);
  if (!isRecord(parsed)) return undefined;
  for (const key of ["tabs", "results", "history", "items", "entries", "files"]) {
    const candidate = parsed[key];
    if (Array.isArray(candidate)) return resultRecords(candidate);
  }
  return undefined;
}

function resultRecords(values: unknown[]): Record<string, unknown>[] | undefined {
  const records = values.filter(isRecord);
  if (records.length !== values.length) return undefined;
  if (
    records.some(
      (record) => !firstString(record, "title", "name", "label", "path", "url", "domain"),
    )
  )
    return undefined;
  return records;
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys)
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}

function domain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

function safeFavicon(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("data:image/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function bounded(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadFile(step: ToolStep): boolean {
  return !step.isError && /^(read|read_file|readfile|openfile)$/i.test(step.toolName);
}

function resultLabel(step: ToolStep): string {
  return step.isError ? "Error details" : step.state === "running" ? "Progress" : "Output";
}
