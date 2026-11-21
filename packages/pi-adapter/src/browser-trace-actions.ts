import type { BrowserTraceAction } from "@aeon/domain";
import type { BrowserTraceActionDto } from "@aeon/protocol";

// The daemon parses these actions with the protocol DTO before a view sees them. A field this
// projection can emit that the DTO lacks would fail that parse and drop the whole tool message,
// so keep the two field sets equal at compile time.
type SameFields<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
export type BrowserTraceActionFieldsMatchProtocol = Assert<
  SameFields<BrowserTraceAction, BrowserTraceActionDto>
>;

// The timed actions of one browser_code call, from the steps the browser recorded: kept in the
// tool result's details (not shown to the model) and surfaced by `aeon trace`. Screen recorders
// (Aperture) rely on them to zoom on each action; keep the shape.
const MAX_ACTIONS = 500;

export function traceActions(steps: readonly Record<string, unknown>[]): BrowserTraceAction[] {
  return steps.flatMap((step) => toAction(step)).slice(-MAX_ACTIONS);
}

/** Validates actions read back from a stored tool result. */
export function storedTraceActions(details: unknown): BrowserTraceAction[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.actions)) return undefined;
  const actions = details.actions.flatMap((item) => (isRecord(item) ? toAction(item, true) : []));
  return actions.length ? actions.slice(-MAX_ACTIONS) : undefined;
}

function toAction(step: Record<string, unknown>, stored = false): BrowserTraceAction[] {
  const action = stored ? step : isRecord(step.action) ? step.action : undefined;
  const kind = stored ? step.kind : action?.op;
  if (typeof kind !== "string" || !kind) return [];
  if (typeof step.tStart !== "number" || typeof step.tEnd !== "number") return [];
  return [
    {
      kind: kind.slice(0, 40),
      tStart: step.tStart,
      tEnd: step.tEnd,
      ...numberField("tabId", tabIdOf(step, action)),
      ...numberField("tAct", step.tAct),
      ...numberField("dpr", step.dpr),
      ...flags(step),
      ...geometry(step),
      ...texts(step, action, stored),
      ...effectFields(step),
    },
  ];
}

/**
 * The tab a step ran in. The engine's timing usually carries it; a step whose timing could not be
 * read (an openTab whose page is still loading) falls back to the tab it opened or targeted, so
 * the run report and anything keyed on tab ids (evals, cleanup) still see that tab.
 */
function tabIdOf(
  step: Record<string, unknown>,
  action: Record<string, unknown> | undefined,
): unknown {
  if (typeof step.tabId === "number") return step.tabId;
  const result = isRecord(step.result) ? step.result : undefined;
  const opened =
    isRecord(result?.tab) && isRecord(result.tab.target) ? result.tab.target.tabId : undefined;
  if (typeof opened === "number") return opened;
  const target = isRecord(action?.target) ? action.target.tabId : undefined;
  return typeof target === "number" ? target : undefined;
}

/** The closed effect of an input step, on the result the engine recorded or the stored row. */
function effectFields(step: Record<string, unknown>): Partial<BrowserTraceAction> {
  const result = isRecord(step.result) ? step.result : undefined;
  const effect = stringOf(step.effect) ?? stringOf(result?.effect);
  const evidence = stringOf(step.evidence) ?? stringOf(result?.evidence);
  return {
    ...(effect ? { effect: effect.slice(0, 20) } : {}),
    ...(evidence ? { evidence: evidence.slice(0, 240) } : {}),
  };
}

function flags(step: Record<string, unknown>): Partial<BrowserTraceAction> {
  return {
    ...(typeof step.visible === "boolean" ? { visible: step.visible } : {}),
    ...(step.disposition === "failed" || step.failed === true ? { failed: true } : {}),
  };
}

function geometry(step: Record<string, unknown>): Partial<BrowserTraceAction> {
  const box = boxOf(step.box),
    point = pointOf(step.point),
    scroll = scrollOf(step.scroll);
  return { ...(box ? { box } : {}), ...(point ? { point } : {}), ...(scroll ? { scroll } : {}) };
}

function visibleText(
  step: Record<string, unknown>,
  action: Record<string, unknown> | undefined,
  stored: boolean,
): string | undefined {
  const event = isRecord(step.event) ? step.event : undefined;
  if (step.sensitive === true || event?.sensitive === true) return undefined;
  const raw = stringOf(stored ? step.text : action?.value);
  return raw === "[hidden password]" ? undefined : raw;
}

function texts(
  step: Record<string, unknown>,
  action: Record<string, unknown> | undefined,
  stored: boolean,
): Partial<BrowserTraceAction> {
  const result = isRecord(step.result) ? step.result : undefined;
  const url = stringOf(action?.url) ?? stringOf(result?.url);
  const text = visibleText(step, action, stored);
  return {
    ...(url ? { url: url.slice(0, 2000) } : {}),
    ...(text ? { text: text.slice(0, 200) } : {}),
  };
}

function boxOf(value: unknown): BrowserTraceAction["box"] {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  return [x, y, width, height].every(isNumber)
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : undefined;
}
function pointOf(value: unknown): BrowserTraceAction["point"] {
  if (!isRecord(value) || !isNumber(value.x) || !isNumber(value.y)) return undefined;
  return { x: value.x, y: value.y };
}
function scrollOf(value: unknown): BrowserTraceAction["scroll"] {
  if (!isRecord(value) || typeof value.direction !== "string") return undefined;
  const { amount, before, after } = value;
  if (![amount, before, after].every(isNumber)) return undefined;
  return {
    direction: value.direction.slice(0, 10),
    amount: amount as number,
    before: before as number,
    after: after as number,
  };
}
function numberField(name: string, value: unknown): Record<string, number> {
  return isNumber(value) ? { [name]: value } : {};
}
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
