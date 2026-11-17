// What a way changes on the site, as an inventory for the model and the UI: `explicit` writes
// (a non-GET request, a commit step, a script that calls write) and `suspected` ones (a step
// whose words or path name a delete, logout or submit). It is never a permission gate: nothing
// reads this list before a run, and Aeon still never asks.

import type {
  Ability,
  AbilityVia,
  AbilityWayApi,
  AbilityWayScript,
  AbilityWaySteps,
} from "./abilities.js";
import type { Operation, SiteModel } from "./types.js";

export type AbilityWriteKind = "explicit" | "suspected";

export interface AbilityWrite {
  /** Stable within the ability: `api:order`, `steps:3`, `script:0`. */
  id: string;
  kind: AbilityWriteKind;
  what: string;
  via: AbilityVia;
  step?: number;
  method?: string;
  path?: string;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const ACTING = /^(click|press|submit|select|check|uncheck|choose|fill|type)$/i;
const SUSPECT =
  /\b(logout|log out|sign out|signout|unsubscribe|delete|remove|archive|trash|destroy|deactivate|revoke|purge|cancel account|close account|clear all)\b/i;
// Opening a page a site then marks visited, seen or in progress is part of a read: the marker
// records that the page was opened, with no answer or form submitted. It is not a write unless the
// caller declared one (i.e. asked to change that progress).
const VISIT_MARKER =
  /\b(visit(ed)?|seen|view(ed)?|read|progress|impression|beacon|analytics|track(ing)?)\b/i;

function visitMarker(path: string | undefined): boolean {
  return Boolean(path && VISIT_MARKER.test(path));
}

/**
 * A declared read that contains an explicit write is a write. Suspected writes stay a note
 * and do not change the kind. A declared write stays a write.
 */
export function kindFromWrites(ability: Ability): Ability["kind"] {
  if (ability.kind === "write") return "write";
  return ability.writes?.some((write) => write.kind === "explicit") ? "write" : ability.kind;
}

export function abilityWrites(ability: Ability, model?: SiteModel): AbilityWrite[] {
  const found: AbilityWrite[] = [];
  ability.ways.forEach((way, index) => {
    if (way.kind === "api") collectApi(way, index, ability, model, found);
    else if (way.kind === "steps") collectSteps(way, index, ability, found);
    else if (way.kind === "script") collectScript(way, index, ability, found);
  });
  return dedupe(found);
}

function collectApi(
  way: AbilityWayApi,
  index: number,
  ability: Ability,
  model: SiteModel | undefined,
  out: AbilityWrite[],
): void {
  const steps = way.operations ?? (way.operation ? [{ operation: way.operation }] : []);
  const commit = Math.min(way.commit ?? steps.length - 1, steps.length - 1);
  steps.forEach((step, stepIndex) => {
    const operation = model?.operations.find((item) => item.id === step.operation);
    // A non-GET is an explicit write even when the caller marked the ability read, and even
    // when the model calls the operation auth rather than action.
    if (operation && (operation.role === "action" || !SAFE.has(operation.method.toUpperCase()))) {
      if (ability.kind !== "read" || !visitMarker(operation.path)) {
        out.push(operationWrite(operation, index, stepIndex));
      }
      return;
    }
    if (operation || ability.kind !== "write" || stepIndex !== commit) return;
    out.push({
      id: `api:${step.operation}`,
      kind: "explicit",
      what: step.operation,
      via: "api",
      step: stepIndex,
    });
  });
}

function operationWrite(operation: Operation, index: number, step: number): AbilityWrite {
  return {
    id: `api:${operation.id}:${index}`,
    kind: "explicit",
    what: operation.id,
    via: "api",
    step,
    method: operation.method.toUpperCase(),
    path: operation.path,
  };
}

function collectSteps(
  way: AbilityWaySteps,
  index: number,
  ability: Ability,
  out: AbilityWrite[],
): void {
  const steps = Array.isArray(way.steps) ? way.steps : [];
  steps.forEach((step, stepIndex) => {
    if (!step || typeof step !== "object") return;
    const write = stepWrite(step as StepShape, stepIndex, steps.length, ability);
    if (write) out.push({ ...write, id: `steps:${index}:${stepIndex}` });
  });
}

interface StepShape {
  kind?: unknown;
  write?: unknown;
  target?: { name?: string; text?: string };
  args?: unknown[];
  expectRequest?: { method?: string; path?: string };
}

function stepWrite(
  saved: StepShape,
  stepIndex: number,
  count: number,
  ability: Ability,
): Omit<AbilityWrite, "id"> | undefined {
  const request = saved.expectRequest;
  const method = request?.method?.toUpperCase();
  const explicit = isExplicit(saved, method, stepIndex, count, ability);
  if (!explicit && !suspicious(saved)) return undefined;
  return withRequest(
    {
      kind: explicit ? "explicit" : "suspected",
      what: labelOf(saved, stepIndex),
      via: "steps",
      step: stepIndex,
    },
    method,
    request?.path,
  );
}

function isExplicit(
  saved: StepShape,
  method: string | undefined,
  stepIndex: number,
  count: number,
  ability: Ability,
): boolean {
  if (saved.write === true) return true;
  if (method !== undefined && !SAFE.has(method)) {
    if (ability.kind === "read" && visitMarker(saved.expectRequest?.path)) return false;
    return true;
  }
  if (ability.kind !== "write" || stepIndex !== count - 1) return false;
  return ACTING.test(typeof saved.kind === "string" ? saved.kind : "");
}

function withRequest(
  base: Omit<AbilityWrite, "id" | "method" | "path">,
  method: string | undefined,
  path: string | undefined,
): Omit<AbilityWrite, "id"> {
  const write = base as Omit<AbilityWrite, "id">;
  if (method) write.method = method;
  if (path) write.path = path;
  return write;
}

function suspicious(step: {
  kind?: unknown;
  target?: { name?: string; text?: string };
  args?: unknown[];
  expectRequest?: { path?: string };
}): boolean {
  const words = [
    typeof step.kind === "string" ? step.kind : "",
    step.target?.name ?? "",
    step.target?.text ?? "",
    ...(step.args ?? []).filter((arg): arg is string => typeof arg === "string"),
    step.expectRequest?.path ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return /^submit$/i.test(String(step.kind)) || SUSPECT.test(words);
}

function labelOf(
  step: { kind?: unknown; target?: { name?: string; text?: string } },
  index: number,
): string {
  return (
    step.target?.name ??
    step.target?.text ??
    (typeof step.kind === "string" ? step.kind : `step ${index + 1}`)
  );
}

function collectScript(
  way: AbilityWayScript,
  index: number,
  ability: Ability,
  out: AbilityWrite[],
): void {
  const explicit = /\bsiteMapper\.(write|batch|undo)\s*\(/.test(way.code);
  if (explicit) {
    out.push({ id: `script:${index}`, kind: "explicit", what: "script", via: "script" });
    return;
  }
  if (ability.kind === "write" || SUSPECT.test(way.code))
    out.push({ id: `script:${index}`, kind: "suspected", what: "script", via: "script" });
}

function dedupe(writes: AbilityWrite[]): AbilityWrite[] {
  const seen = new Set<string>();
  return writes.filter((write) => {
    if (seen.has(write.id)) return false;
    seen.add(write.id);
    return true;
  });
}
