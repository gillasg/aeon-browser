// Runs one way of an ability against a host: an API call or chain, a workflow, a page collect,
// or a script. The runner decides the order and what a failure means; this file only attempts.

import { runNodeScript } from "./ability-node.js";
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
import { siteName } from "./registry.js";

export async function attemptWay(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  if (way.kind === "api") return attemptApi(way, inputs, host, progress);
  if (way.kind === "steps") return attemptSteps(way, inputs, host);
  if (way.kind === "page") return attemptPage(way, inputs, host);
  return attemptScript(ability, way, inputs, host);
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
    if (progress && index >= commit) progress.reachedCommit = true;
    result = await callApiStep(step, way, inputs, stepResults, call, host);
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
): Promise<unknown> {
  if (!host.workflow) throw new Error("No workflow runtime is attached");
  return host.workflow({
    ...(way.name ? { name: way.name } : {}),
    ...(way.workflow ? { workflow: way.workflow } : {}),
    inputs: { ...inputs, ...(fill(way.params ?? {}, inputs) as Record<string, unknown>) },
  });
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
): Promise<unknown> {
  if (way.runtime === "page") return runPageScript(way, inputs, host);
  return runNodeScript(
    way.code,
    inputs,
    host.call ?? (async (operation, params) => handleCall(ability.site, operation, params)),
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
  return host.script(code, { inputs, ...extra });
}

async function handleCall(
  site: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { handleSiteMapperRequest } = await import("./requests.js");
  return handleSiteMapperRequest({ siteMapper: "call", site, operation, params });
}

/** Site calls through the mapped runtime; page ways and page scripts in a browser tab on the site. */
export function defaultHost(site: string): AbilityHost {
  const browser = once(async () => {
    const { browserRecipeHost } = await import("./runtime/recipe-host.js");
    return browserRecipeHost(site, { session: `ability-${siteName(site)}` });
  });
  return {
    call: (operation, params) => handleCall(site, operation, params),
    write: (operation, params) => handleCall(site, operation, params),
    open: async (url) => required(await browser(), "open")(url),
    collect: async (input) => required(await browser(), "collect")(input),
    script: async (code, input) => required(await browser(), "script")(onSite(site, code), input),
  };
}

/** Wraps a page script so it runs on a tab of its own site, opening one in the background if needed. */
function onSite(site: string, code: string): string {
  const host = siteName(site);
  return `async (page, bu, inputs) => {
  let tab = page;
  try { if (!tab || !new URL(await tab.url()).hostname.endsWith(${JSON.stringify(host)})) tab = undefined; } catch { tab = undefined; }
  tab ??= await browser.openTab(${JSON.stringify(`https://${host}/`)}, { active: false });
  return await (${code})(tab, bu, inputs);
}`;
}

function required<K extends "open" | "collect" | "script">(
  host: AbilityHost,
  name: K,
): NonNullable<AbilityHost[K]> {
  const run = host[name];
  if (!run) throw new Error(`ABILITY_NEEDS: the browser host has no ${name}`);
  return run as NonNullable<AbilityHost[K]>;
}

function once<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
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
