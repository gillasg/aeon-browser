// Runs one way of an ability against a host: an API call or chain, a workflow, a page collect,
// or a script. The runner decides the order and what a failure means; this file only attempts.

import { runNodeScript } from "./ability-node.js";
import { refuseUnsettled } from "./ability-writes.js";
import { closestControls, resolveControl, type FallbackTarget } from "./step-fallbacks.js";
import type {
  Ability,
  AbilityApiStep,
  AbilityHost,
  AbilityWay,
  AbilityWayApi,
  AbilityWayPage,
  AbilityWayScript,
  AbilityWaySteps,
} from "./abilities.js";
export { defaultHost, readOnlyHost } from "./ability-host.js";
import { handleCall } from "./ability-host.js";

export async function attemptWay(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  if (way.kind === "api") return attemptApi(way, inputs, host, progress);
  if (way.kind === "steps") return attemptSteps(way, inputs, host, progress);
  if (way.kind === "page") return attemptPage(way, inputs, host);
  return attemptScript(ability, way, inputs, host, progress);
}

async function attemptApi(
  way: AbilityWayApi,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  const operations = apiOperations(way);
  if (!operations.length) throw new Error("API way has no operation");
  const call = host.write ?? host.call;
  if (!call) throw new Error("ABILITY_NEEDS: no site API transport");
  if (way.open) await openForApi(way, inputs, host);
  const stepResults: unknown[] = [];
  const commit = Math.min(way.commit ?? operations.length - 1, operations.length - 1);
  let result: unknown;
  for (const [index, step] of operations.entries()) {
    if (progress && index >= commit && !step.settings) progress.reachedCommit = true;
    result = await callApiStep(step, way, inputs, stepResults, call, host);
    refuseUnsettled(result, progress?.reachedCommit === true);
  }
  return result;
}

function apiOperations(way: AbilityWayApi): AbilityApiStep[] {
  if (way.operations) return way.operations;
  return way.operation ? [{ operation: way.operation }] : [];
}

async function openForApi(
  way: AbilityWayApi,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<void> {
  if (!way.open) return;
  if (!host.open) throw new Error("ABILITY_NEEDS: this host cannot open a page for that way");
  await host.open(String(fill(way.open, inputs)));
}

async function callApiStep(
  step: AbilityApiStep,
  way: AbilityWayApi,
  inputs: Record<string, unknown>,
  stepResults: unknown[],
  call: (operation: string, params: Record<string, unknown>) => Promise<unknown>,
  host: AbilityHost,
): Promise<unknown> {
  const params = fill(
    { ...(way.params ?? {}), ...(step.params ?? {}) },
    inputs,
    stepResults,
  ) as Record<string, unknown>;
  const result = await call(host.resolveOperation?.(step.operation) ?? step.operation, params);
  stepResults.push(result);
  return result;
}

async function attemptSteps(
  way: AbilityWaySteps,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  if (host.act && host.controls && savedSteps(way).length)
    return replaySaved(way, inputs, host, progress);
  if (!host.workflow) throw new Error("No workflow runtime is attached");
  if (progress) progress.reachedCommit = true;
  return host.workflow({
    ...(way.name ? { name: way.name } : {}),
    ...(way.workflow ? { workflow: way.workflow } : {}),
    inputs: { ...inputs, ...(fill(way.params ?? {}, inputs) as Record<string, unknown>) },
  });
}

interface SavedStep {
  kind: string;
  target?: FallbackTarget;
  args?: string[];
  onPageType?: string;
  /** Click only changes a choice that spends nothing until a later step commits. */
  settings?: true;
}

function savedSteps(way: AbilityWaySteps): SavedStep[] {
  if (!Array.isArray(way.steps)) return [];
  return way.steps.filter(isSavedStep);
}

function isSavedStep(value: unknown): value is SavedStep {
  return Boolean(
    value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string",
  );
}

async function replaySaved(
  way: AbilityWaySteps,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  const act = host.act;
  if (!act || !host.controls) throw new Error("ABILITY_NEEDS: no step replay is attached");
  const steps = savedSteps(way);
  const commit = Math.min(way.commit ?? steps.length - 1, Math.max(steps.length - 1, 0));
  let last: unknown;
  for (const [index, step] of steps.entries()) {
    const target = await currentTarget(step, fillTarget(step.target, inputs), host);
    if (progress && index >= commit && !step.settings) progress.reachedCommit = true;
    last = await act({
      kind: step.kind,
      ...(target ? { target } : {}),
      args: fillArgs(step.args, inputs),
    });
    refuseUnsettled(last, progress?.reachedCommit === true);
  }
  return last;
}

/** The control a saved step acts on now: the saved one, or one renamed control (reported as adapted). */
async function currentTarget(
  step: SavedStep,
  target: FallbackTarget | undefined,
  host: AbilityHost,
): Promise<FallbackTarget | undefined> {
  const page = step.onPageType && host.pageType ? await host.pageType() : undefined;
  if (step.onPageType && page && page !== step.onPageType)
    throw new Error(`ABILITY_DRIFT: page type ${page} is not ${step.onPageType}`);
  if (!target || !host.controls) return target;
  const controls = await host.controls();
  const hit = resolveControl(target, controls);
  if (!hit) throw new Error(driftMessage(target, closestControls(target, controls)));
  if (hit.adapted) host.noteAdapted?.({ from: pick(target), to: pick(hit.control) });
  return { ...target, ...pick(hit.control) };
}

function pick(control: FallbackTarget): { role?: string; name?: string } {
  return {
    ...(control.role ? { role: control.role } : {}),
    ...(control.name ? { name: control.name } : {}),
  };
}

function driftMessage(target: FallbackTarget, closest: FallbackTarget[]): string {
  const wanted = `${target.role ?? "control"} ${JSON.stringify(target.name ?? target.text ?? target.css ?? "")}`;
  const near = closest.map((item) => `${item.role ?? "?"} ${JSON.stringify(item.name ?? "")}`);
  return `ABILITY_DRIFT: no ${wanted} on the page now${near.length ? `; closest: ${near.join(", ")}` : ""}`;
}

function fillTarget(
  target: FallbackTarget | undefined,
  inputs: Record<string, unknown>,
): FallbackTarget | undefined {
  if (!target) return undefined;
  return {
    ...target,
    ...(target.name ? { name: fillText(target.name, inputs) } : {}),
    ...(target.text ? { text: fillText(target.text, inputs) } : {}),
  };
}

function fillArgs(args: string[] | undefined, inputs: Record<string, unknown>): string[] {
  return (args ?? []).map((arg) => fillText(arg, inputs));
}

function fillText(text: string, inputs: Record<string, unknown>): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(inputs, name) ? String(inputs[name]) : whole,
  );
}

async function attemptPage(
  way: AbilityWayPage,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  if (!host.collect) throw new Error("No browser is attached for a page way");
  return host.collect({
    ...(way.collect ?? { row: "body", fields: {} }),
    ...(way.url ? { url: fill(way.url, inputs) as string } : {}),
  });
}

async function attemptScript(
  ability: Ability,
  way: AbilityWayScript,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  if (way.runtime === "page") {
    if (!host.script) throw new Error("No browser is attached for a page script");
    if (progress) progress.reachedCommit = true;
    try {
      return await runPageScript(way, inputs, host);
    } catch (error) {
      // A script that threw before it touched the page cannot have committed anything.
      if (progress && (error as { pageUntouched?: boolean }).pageUntouched)
        progress.reachedCommit = false;
      throw error;
    }
  }
  if (progress) progress.reachedCommit = true;
  return runNodeScript(
    way.code,
    inputs,
    host.call ?? (async (operation, params) => handleCall(ability.site, operation, params)),
    ability.site,
  );
}

async function runPageScript(
  way: AbilityWayScript,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  if (!host.script) throw new Error("No browser is attached for a page script");
  const code = /^\s*(async\s*)?\(/.test(way.code)
    ? way.code
    : `async (page, bu, inputs) => { ${way.code}\n return inputs; }`;
  const extra = (way.input && typeof way.input === "object" ? way.input : {}) as Record<
    string,
    unknown
  >;
  // The script gets the inputs themselves (flat), over the way's own defaults.
  return host.script(code, { ...extra, ...inputs });
}

/** Fills `{{inputs.x}}` and `{{last.field}}` in a way's params. */
export function fill(
  value: unknown,
  inputs: Record<string, unknown>,
  steps: unknown[] = [],
): unknown {
  if (typeof value === "string") return fillString(value, inputs, steps);
  if (Array.isArray(value)) return value.map((item) => fill(item, inputs, steps));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, inputs, steps)]),
    );
  return value;
}

function fillString(value: string, inputs: Record<string, unknown>, steps: unknown[]): unknown {
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
  if (whole) return lookup(whole[1] ?? "", inputs, steps);
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) =>
    String(lookup(path, inputs, steps) ?? ""),
  );
}

function lookup(path: string, inputs: Record<string, unknown>, steps: unknown[]): unknown {
  const [head = "", ...rest] = path.split(".");
  let value = lookupHead(head, inputs, steps);
  for (const key of rest) value = (value as Record<string, unknown> | undefined)?.[key];
  return value;
}

function lookupHead(head: string, inputs: Record<string, unknown>, steps: unknown[]): unknown {
  if (head === "inputs") return inputs;
  if (head === "last") return steps[steps.length - 1];
  if (head === "steps") return steps;
  return undefined;
}
