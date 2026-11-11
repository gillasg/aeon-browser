import { actionLine, StepEventSchema } from "@aeon/protocol";
import { partialListLine } from "@browserkit/engine/read-guards";
import { rateLimitWarning } from "@browserkit/engine/rate-limit";
import { formatCellNow } from "./first-turn.js";

export interface CellText {
  steps: Record<string, unknown>[];
  output: string;
  value?: unknown;
  error?: string;
  reset?: boolean;
  runLog?: string;
  hint?: string;
  startedAt?: number;
  tabStats?: {
    opened?: number;
    closed?: number;
    mine?: number[];
    total?: number;
    popups?: number;
  };
}

export function formatCell(body: CellText, now = new Date()): string {
  const parts = [...didLines(body.steps), ...headLines(body), ...tailLines(body, now)];
  return parts.filter((part) => part.length > 0).join("\n");
}

function headLines(body: CellText): string[] {
  const lines: string[] = [];
  if (body.output) lines.push("output:\n" + body.output);
  const value = valueLine(body);
  if (value) lines.push(value);
  lines.push(...valueNotes(body.value));
  const warning = rateLimitWarning(rateText(body), statusOf(body.value));
  if (warning) lines.push(warning);
  return lines;
}

function valueLine(body: CellText): string {
  if (body.value === undefined || echoed(body.output, body.value)) return "";
  return "value: " + (JSON.stringify(body.value) ?? "undefined");
}

function tailLines(body: CellText, now: Date): string[] {
  const lines: string[] = [];
  if (failedLong(body)) lines.push(...ranLines(body.steps));
  if (body.error) lines.push("error: " + body.error);
  const page = pageOf(body.steps);
  if (page) lines.push(page);
  lines.push(...metaLines(body));
  lines.push(clockLine(body, now));
  // The batch hint stays last so the model reads it after the clock.
  if (body.hint) lines.push("hint: " + body.hint);
  return lines;
}

function failedLong(body: CellText): boolean {
  return Boolean(body.error) && actionCount(body.steps) >= 5;
}

function metaLines(body: CellText): string[] {
  const lines: string[] = [];
  if (body.reset) lines.push("runtime reset: top-level variables are gone");
  if (body.tabStats) lines.push(tabLine(body.tabStats));
  if (body.runLog) lines.push("run log: " + body.runLog);
  return lines;
}

export function formatStepLine(step: Record<string, unknown>): string {
  return didLines([step]).join("\n");
}

function didLines(steps: Record<string, unknown>[]): string[] {
  const lines = steps.filter((step) => step.action !== undefined).flatMap(stepLines);
  if (lines.length <= 40) return lines;
  return [...lines.slice(0, 10), "...", ...lines.slice(-29)];
}

function stepLines(step: Record<string, unknown>): string[] {
  if (step.loopFolded) return [];
  const did = didText(step);
  if (!did) return [];
  const lines = [`[did] ${did}`];
  const warn = warnText(step);
  if (warn) lines.push(`[warn] ${warn}`);
  const next = nextText(step);
  if (next) lines.push(`[next] ${next}`);
  return lines;
}

function didText(step: Record<string, unknown>): string {
  const event = StepEventSchema.safeParse(step.event);
  if (event.success) return actionLine(event.data);
  return legacyText(step);
}

function legacyText(step: Record<string, unknown>): string {
  if (typeof step.action !== "object" || step.action === null) return String(step.action ?? "");
  const action = step.action as Record<string, unknown>;
  const detail = actionDetail(action);
  const opened = openedTab(step);
  const failed = step.disposition === "failed" ? failedText(step) : "";
  return String(action.op) + (detail ? " " + detail : "") + opened + failed;
}

function warnText(step: Record<string, unknown>): string {
  if (step.disposition === "failed") return String(step.code ?? "failed");
  const event = StepEventSchema.safeParse(step.event);
  if (event.success && event.data.effect === "refused") return "refused";
  return "";
}

function nextText(step: Record<string, unknown>): string {
  if (!needsNext(step)) return "";
  const next = (step.result as { next?: unknown } | undefined)?.next;
  if (typeof next !== "string" || !next) return "";
  if (String(step.code ?? "").includes("\nNext:")) return "";
  return next;
}

function needsNext(step: Record<string, unknown>): boolean {
  if (step.disposition === "failed") return true;
  const effect = effectOf(step);
  return effect === "suspected_noop" || effect === "refused";
}

function effectOf(step: Record<string, unknown>): string {
  const event = StepEventSchema.safeParse(step.event);
  if (event.success && event.data.effect) return event.data.effect;
  const result = step.result as { effect?: unknown } | undefined;
  return typeof result?.effect === "string" ? result.effect : "";
}

export function ranLines(steps: Record<string, unknown>[]): string[] {
  return steps
    .filter((step) => step.action !== undefined && !step.loopFolded)
    .map((step, index) => `[ran] ${index + 1} ${didText(step)}`);
}

function actionCount(steps: Record<string, unknown>[]): number {
  return steps.filter((step) => step.action !== undefined && !step.loopFolded).length;
}

function valueNotes(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  const list = listOf(record);
  return [factNote(record, list), locationNote(record), partialNote(list)].filter(present);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function listOf(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.list) ?? record;
}

function factNote(record: Record<string, unknown>, list: Record<string, unknown>): string {
  return stringField(record, "contradiction") || stringField(list, "contradiction");
}

function locationNote(record: Record<string, unknown>): string {
  const location = stringField(record, "location");
  return location ? `location: ${location}` : "";
}

function partialNote(list: Record<string, unknown>): string {
  if (list.partial !== true) return "";
  const shown = typeof list.count === "number" ? list.count : undefined;
  const total = typeof list.total === "number" ? list.total : undefined;
  if (shown === undefined || total === undefined) return "";
  return partialListLine(shown, total) ?? "";
}

function present(line: string): boolean {
  return line.length > 0;
}

function clockLine(body: CellText, now: Date): string {
  const zone = process.env.AEON_SURFACE_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const mine = body.tabStats?.mine?.length ?? 0;
  const total = body.tabStats?.total && body.tabStats.total > 0 ? body.tabStats.total : 8;
  const elapsed = body.startedAt === undefined ? 0 : Math.max(0, now.getTime() - body.startedAt);
  return formatCellNow(now, zone, elapsed, `${mine}/${total}`);
}

function pageOf(steps: Record<string, unknown>[]): string {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const url = urlOf(steps[index]);
    if (!url) continue;
    try {
      return `[page] ${new URL(url).host.replace(/^www\./, "")}`;
    } catch {
      return `[page] ${url}`;
    }
  }
  return "";
}

function urlOf(step: Record<string, unknown> | undefined): string {
  const action = step?.action as { url?: unknown } | undefined;
  if (typeof action?.url === "string") return action.url;
  const result = step?.result as { url?: unknown; tab?: { url?: unknown } } | undefined;
  if (typeof result?.url === "string") return result.url;
  if (typeof result?.tab?.url === "string") return result.tab.url;
  return "";
}

function rateText(body: CellText): string {
  const value = typeof body.value === "string" ? body.value : "";
  return `${body.output}\n${value}`.slice(0, 4000);
}

function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function echoed(output: string, value: unknown): boolean {
  return typeof value === "string" && value.length > 40 && output.includes(value);
}

function tabLine(stats: NonNullable<CellText["tabStats"]>): string {
  const ids = stats.mine ?? [];
  return (
    `tabs: opened ${stats.opened ?? 0}, closed ${stats.closed ?? 0}, mine ${ids.length}` +
    `${ids.length ? ` (${ids.join(", ")})` : ""}, total ${stats.total ?? 0}` +
    `${stats.popups ? `; popups: ${stats.popups} parked` : ""}`
  );
}

function openedTab(step: Record<string, unknown>): string {
  const result = step.result as
    { kind?: unknown; tab?: { target?: { tabId?: unknown } } } | undefined;
  return result?.kind === "tab" ? " -> tab " + String(result.tab?.target?.tabId) : "";
}

function failedText(step: Record<string, unknown>): string {
  const detail = step.detail ? ": " + String(step.detail) : "";
  return " FAILED " + String(step.code ?? "") + detail;
}

function actionDetail(action: Record<string, unknown>): string {
  const target = action.target as { tabId?: unknown } | undefined;
  const element = action.element as Record<string, unknown> | undefined;
  const id = element && (element.backendNodeId ?? element.value ?? element.ref ?? element.role);
  return [
    target?.tabId !== undefined ? "tab " + String(target.tabId) : "",
    typeof action.url === "string" ? action.url : "",
    id === undefined ? "" : String(id),
    typeof action.method === "string" ? action.method : "",
  ]
    .filter(Boolean)
    .join(" ");
}
