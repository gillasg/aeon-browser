import { StepEventSchema, type StepEvent, type StepEffect } from "@browserkit/protocol";
import { isSensitive, labelFor, targetOf } from "./label.js";
import { requestPath } from "./receipt.js";

/** Events kept per cell. Further steps fold into the last one. */
export const MAX_STEP_EVENTS = 500;

const WRITES = new Set([
  "click",
  "fill",
  "press",
  "select",
  "upload",
  "navigate",
  "open",
  "close",
  "dialog",
  "download",
  "handoff",
  "ability",
]);

const KINDS = new Set<StepEvent["kind"]>([
  "click",
  "fill",
  "press",
  "select",
  "upload",
  "navigate",
  "open",
  "close",
  "read",
  "api",
  "ability",
  "handoff",
  "dialog",
  "download",
]);

const loopCounts = new WeakMap<StepEvent, number>();
const progressCounts = new WeakMap<StepEvent, number>();

export function stepEventFrom(input: {
  cellId: string;
  chatId: string;
  index: number;
  step: { op: string; element?: unknown; key?: string; url?: string; target?: { tabId?: number } };
  entry: Record<string, unknown>;
}): StepEvent | undefined {
  const kind = kindOf(input.step.op);
  if (!kind) return undefined;
  const result = record(input.entry.result);
  const target = eventTarget(input.step.element);
  const effect = effectOf(input.entry, result);
  const evidence = evidenceOf(result);
  const sensitive = Boolean(target && isSensitive(target));
  const box = boxOf(input.entry.box);
  const label = labelFor({
    kind,
    ...(target ? { target } : {}),
    ...(input.step.key ? { key: input.step.key } : {}),
    ...(typeof input.step.url === "string" ? { url: input.step.url } : {}),
    ...(typeof result?.url === "string" ? { url: result.url } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  }).slice(0, 200);
  const event = {
    id: `${input.cellId}:${input.index}`.slice(0, 80),
    cellId: input.cellId.slice(0, 80),
    chatId: input.chatId.slice(0, 80),
    tabId: tabOf(input),
    at: numberOf(input.entry.tEnd) ?? Date.now(),
    ms: Math.max(0, numberOf(input.entry.ms) ?? 0),
    kind,
    label,
    site: siteOf(result?.url).slice(0, 200),
    write: WRITES.has(kind) && effect === "confirmed",
    via: "page" as const,
    ...(target ? { target: wireTarget(target) } : {}),
    ...(effect ? { effect } : {}),
    ...(evidence ? { evidence } : {}),
    ...(box ? { box } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  };
  const parsed = StepEventSchema.safeParse(event);
  return parsed.success ? parsed.data : undefined;
}

/** Writes the step's event onto the trace entry, folding a repeat into the previous event. */
export function recordStep(
  events: StepEvent[],
  input: {
    cellId: string;
    chatId: string;
    index: number;
    step: {
      op: string;
      element?: unknown;
      key?: unknown;
      url?: unknown;
      target?: { tabId?: number };
    };
    entry: Record<string, unknown>;
  },
): void {
  const event = stepEventFrom({
    cellId: input.cellId,
    chatId: input.chatId,
    index: input.index,
    step: {
      op: input.step.op,
      ...(input.step.element !== undefined ? { element: input.step.element } : {}),
      ...(typeof input.step.key === "string" ? { key: input.step.key } : {}),
      ...(typeof input.step.url === "string" ? { url: input.step.url } : {}),
      ...(input.step.target ? { target: input.step.target } : {}),
    },
    entry: input.entry,
  });
  if (!event) return;
  if (rememberStep(events, event) === "fold") {
    input.entry.loopFolded = true;
    input.entry.event = events.at(-1);
    return;
  }
  input.entry.event = event;
}

/** Appends, or folds a repeat (and anything past the cap) into the last event, in place. */
export function rememberStep(events: StepEvent[], next: StepEvent): "append" | "fold" {
  const last = events.at(-1);
  if (last && sameLoop(last, next)) {
    foldInto(last, next, false);
    return "fold";
  }
  if (last && events.length >= MAX_STEP_EVENTS) {
    foldInto(last, next, true);
    return "fold";
  }
  loopCounts.set(next, 1);
  events.push(next);
  return "append";
}

/** Labels of steps that changed a site. The ledger (D13) reads these; it is not written here. */
export function ledgerLabels(events: readonly StepEvent[]): string[] {
  return events.filter((event) => event.write).map((event) => event.label);
}

function foldInto(last: StepEvent, next: StepEvent, capped: boolean): void {
  last.ms += next.ms;
  last.at = next.at;
  if (capped) {
    const count = (progressCounts.get(last) ?? MAX_STEP_EVENTS) + 1;
    progressCounts.set(last, count);
    last.label = `Progress · ${count} steps`.slice(0, 200);
    return;
  }
  const count = (loopCounts.get(last) ?? 1) + 1;
  last.label = `${stripCount(last.label)} · ${count}`.slice(0, 200);
  loopCounts.set(last, count);
}

function sameLoop(left: StepEvent, right: StepEvent): boolean {
  const name = left.target?.name || "";
  const id = left.target?.id;
  if (!name && id === undefined) return false;
  return (
    left.kind === right.kind &&
    left.site === right.site &&
    left.target?.role === right.target?.role &&
    left.target?.name === right.target?.name &&
    left.target?.id === right.target?.id
  );
}

function stripCount(label: string): string {
  return label.replace(/ · \d+$/, "");
}

function kindOf(op: string): StepEvent["kind"] | undefined {
  const kind =
    op === "paste"
      ? "fill"
      : op === "keys" || op === "pointer"
        ? "press"
        : op === "openTab"
          ? "open"
          : op === "closeTab"
            ? "close"
            : op === "observe" ||
                op === "snapshot" ||
                op === "markdown" ||
                op === "evaluate" ||
                op === "listTabs"
              ? "read"
              : op;
  return KINDS.has(kind as StepEvent["kind"]) ? (kind as StepEvent["kind"]) : undefined;
}

function eventTarget(element: unknown): { role: string; name: string; id?: number } | undefined {
  const named = targetOf(element);
  if (!named?.role && !named?.name) return undefined;
  const id = backendId(element);
  return {
    role: (named?.role ?? "").slice(0, 80),
    name: (named?.name ?? "").slice(0, 160),
    ...(id !== undefined ? { id } : {}),
  };
}

function wireTarget(target: { role: string; name: string; id?: number }): {
  role: string;
  name: string;
  id?: number;
} {
  return {
    role: target.role,
    name: target.name,
    ...(target.id !== undefined ? { id: target.id } : {}),
  };
}

function backendId(element: unknown): number | undefined {
  if (!element || typeof element !== "object") return undefined;
  const id = (element as { backendNodeId?: unknown }).backendNodeId;
  return typeof id === "number" ? id : undefined;
}

function effectOf(
  entry: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): StepEffect | undefined {
  const value = result?.effect ?? entry.effect;
  if (isEffect(value)) return value;
  return entry.disposition === "failed" ? "refused" : undefined;
}

function evidenceOf(
  result: Record<string, unknown> | undefined,
): StepEvent["evidence"] | undefined {
  if (!result) return undefined;
  const receipt = record(result.receipt);
  const request = firstRequest(receipt?.requests);
  if (request)
    return {
      request: {
        method: String(request.method ?? "GET").slice(0, 20),
        path: requestPath(String(request.url ?? "")).slice(0, 300),
        status: typeof request.status === "number" ? request.status : 0,
      },
    };
  if (receipt?.navigated === true && typeof result.url === "string")
    return { navigated: result.url.slice(0, 500) };
  const download = record(receipt?.download);
  if (typeof download?.filename === "string" && download.filename)
    return { download: { name: download.filename.slice(0, 300) } };
  const dialog = dialogOf(receipt?.dialog);
  if (dialog) return { dialog };
  if (typeof result.evidence === "string" && result.evidence.includes("value read back"))
    return { valueRead: true };
  return undefined;
}

function firstRequest(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? record(value[0]) : undefined;
}

function dialogOf(
  value: unknown,
): { type: string; message: string; accepted: boolean } | undefined {
  const dialog = record(value);
  if (!dialog || typeof dialog.type !== "string" || typeof dialog.message !== "string")
    return undefined;
  return {
    type: dialog.type.slice(0, 40),
    message: dialog.message.slice(0, 300),
    accepted: Boolean(dialog.accepted),
  };
}

function boxOf(value: unknown): StepEvent["box"] | undefined {
  const box = record(value);
  const x = box?.x;
  const y = box?.y;
  const width = box?.width;
  const height = box?.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  )
    return undefined;
  return { x, y, width, height };
}

function tabOf(input: {
  step: { target?: { tabId?: number } };
  entry: Record<string, unknown>;
}): number {
  if (typeof input.entry.tabId === "number") return input.entry.tabId;
  return input.step.target?.tabId ?? 0;
}

function siteOf(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isEffect(value: unknown): value is StepEffect {
  return (
    value === "confirmed" ||
    value === "unverifiable" ||
    value === "suspected_noop" ||
    value === "refused"
  );
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
