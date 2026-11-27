// Rung 0: a prompt that matches a promoted route exactly runs its ability with no model. Only a
// clean hit runs: a high word score, every slot filled from the prompt with no doubt, a read (or
// a write the user explicitly marked safe to repeat), and a way that executes on its own. Any
// miss, doubt, error or timeout returns a miss and the chat goes to the model as usual.

import {
  listRoutes,
  matchSavedRoute,
  readAbility,
  runAbility,
  sitesNamed,
  type Ability,
  type AbilityRunResult,
  type Route,
  type RouteHit,
} from "@browserkit/site-mapper";
import type { PiBrowserContextRecord, PiSessionEvent, PiSessionInput } from "@graft/domain";

/** A word score below this stays with the model. */
export const RUNG0_MIN_SCORE = 0.8;
const TIMEOUT_MS = 20_000;
const ANSWER_CAP = 6_000;

export interface Rung0Deps {
  listRoutes: (site: string) => Promise<Route[]>;
  readAbility: (site: string, name: string) => Promise<Ability | undefined>;
  runAbility: (
    site: string,
    name: string,
    inputs: Record<string, unknown>,
  ) => Promise<AbilityRunResult>;
  now?: () => number;
  timeoutMs?: number;
}

export interface Rung0Hit {
  hit: true;
  site: string;
  abilityId: string;
  routeId: string;
  inputs: Record<string, string>;
  answer: string;
  result: unknown;
  elapsedMs: number;
  /** Always 0: the proof the receipt shows. */
  modelTurns: 0;
  compiled: boolean;
  via: AbilityRunResult["via"];
  receipt: string;
}

export interface Rung0Miss {
  hit: false;
  reason: string;
}

export type Rung0Outcome = Rung0Hit | Rung0Miss;

const defaults: Rung0Deps = {
  listRoutes: (site) => listRoutes(site),
  readAbility: (site, name) => readAbility(site, name),
  runAbility: (site, name, inputs) => runAbility(site, name, inputs),
};

/** Runs the prompt at rung 0 when it can; never throws. `sites` adds sites from browser context. */
export async function tryRung0(
  prompt: string,
  context: { sites?: readonly string[] } = {},
  deps: Rung0Deps = defaults,
): Promise<Rung0Outcome> {
  try {
    return await attempt(prompt, context, deps);
  } catch (error) {
    return {
      hit: false,
      reason: `error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function attempt(
  prompt: string,
  context: { sites?: readonly string[] },
  deps: Rung0Deps,
): Promise<Rung0Outcome> {
  const sites = [...new Set([...sitesNamed(prompt), ...(context.sites ?? [])])];
  if (!sites.length) return { hit: false, reason: "no site" };
  const found = await bestHit(prompt, sites, deps);
  if (!found) return { hit: false, reason: "no route" };
  const doubt = routeDoubt(prompt, found);
  if (doubt) return { hit: false, reason: doubt };
  const { route, inputs } = found;
  const name = (route.abilityId ?? "").slice(route.site.length + 1);
  const ability = await deps.readAbility(route.site, name);
  if (!ability) return { hit: false, reason: "ability gone" };
  const unsafe = safetyProblem(ability, route);
  if (unsafe) return { hit: false, reason: unsafe };
  if (!ability.ways.some(runsAlone)) return { hit: false, reason: "no executable way" };
  return runHit(route, name, inputs, deps);
}

/** Why a matched route is not a clean hit, or undefined when it is. */
function routeDoubt(prompt: string, found: RouteHit): string | undefined {
  const { route, inputs, score } = found;
  if (score < RUNG0_MIN_SCORE) return "low score";
  if (!route.abilityId) return "not promoted";
  if (route.ambiguous) return "ambiguous slots";
  if (route.inputs.some((input) => !inputs[input.name])) return "slot missing";
  return slotsClash(prompt, route, inputs) ? "slot uncertain" : undefined;
}

async function runHit(
  route: Route,
  name: string,
  inputs: Record<string, string>,
  deps: Rung0Deps,
): Promise<Rung0Outcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const run = await withTimeout(
    deps.runAbility(route.site, name, inputs),
    deps.timeoutMs ?? TIMEOUT_MS,
  );
  if (!run) return { hit: false, reason: "timeout" };
  if (!usable(run)) return { hit: false, reason: "empty or unverified result" };
  const elapsedMs = Math.max(0, Math.round(run.elapsedMs ?? now() - started));
  return {
    hit: true,
    site: route.site,
    abilityId: route.abilityId ?? "",
    routeId: route.id,
    inputs,
    answer: answerText(run.result),
    result: run.result,
    elapsedMs,
    modelTurns: 0,
    compiled: run.compiled ?? run.via === "api",
    via: run.via,
    receipt: run.receipt ?? `${elapsedMs}ms · no model`,
  };
}

async function bestHit(prompt: string, sites: string[], deps: Rung0Deps) {
  let best: RouteHit | undefined;
  for (const site of sites) {
    const routes = await deps.listRoutes(site).catch(() => [] as Route[]);
    const hit = matchSavedRoute(prompt, routes);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

/**
 * A slot is certain only when its value is written in the prompt once and no other slot took the
 * same value. A number the matcher guessed from several in the prompt is not certain.
 */
function slotsClash(prompt: string, route: Route, inputs: Record<string, string>): boolean {
  const values = route.inputs.map((input) => inputs[input.name] ?? "");
  if (new Set(values).size !== values.length) return true;
  const numbers = [...prompt.matchAll(/\b\d{2,}\b/g)].map((match) => match[0]);
  return values.some((value) => {
    if (!prompt.includes(value)) return true;
    return /^\d+$/.test(value) && numbers.filter((number) => number !== value).length > 0;
  });
}

/** Reads run; a write runs only when the user marked it safe to repeat with no confirmation. */
export function safetyProblem(ability: Ability, route: Route): string | undefined {
  const writes =
    ability.kind === "write" ||
    route.writes ||
    ability.effect === "write" ||
    ability.effect === "irreversible";
  if (!writes) return undefined;
  if (ability.effect === "irreversible") return "irreversible write";
  return ability.options.rung0Confirmed === true ? undefined : "unconfirmed write";
}

/** A way the default host executes without a model or a control replayer. */
function runsAlone(way: Ability["ways"][number]): boolean {
  if (way.kind === "api") return Boolean(way.operation || way.operations?.length);
  if (way.kind === "script") return Boolean(way.code.trim());
  return way.kind === "page";
}

function usable(run: AbilityRunResult): boolean {
  if (run.unverified?.length || run.stale) return false;
  const value = run.result;
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value) && !value.length) return false;
  return true;
}

function answerText(result: unknown): string {
  const inner =
    result && typeof result === "object" && !Array.isArray(result) && "result" in result
      ? (result as { result: unknown }).result
      : result;
  const text = typeof inner === "string" ? inner : JSON.stringify(inner, null, 1);
  return text.length > ANSWER_CAP ? `${text.slice(0, ANSWER_CAP)}…` : text;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The chat line for a hit: the answer, and the honest proof it came from no model. */
export function rung0Notice(hit: Rung0Hit): { text: string; detail: string } {
  const how = hit.compiled ? "compiled API" : hit.via;
  return {
    text: hit.answer,
    detail: `${hit.site} · ${hit.elapsedMs}ms · 0 model turns · ${how} · ${hit.abilityId}`,
  };
}

/** Only a plain prompt is a candidate: attachments and a selected passage need the model. */
export function rung0Eligible(input: PiSessionInput): boolean {
  if (input.attachments?.length || input.routeDraft) return false;
  return contextsOf(input).every((context) => context.kind === "page");
}

/** Sites of the tabs the prompt was sent from, so "my orders for 2025" knows where. */
export function rung0Sites(input: PiSessionInput): string[] {
  const sites = new Set<string>();
  for (const context of contextsOf(input)) {
    if (context.sourceStatus && context.sourceStatus !== "current") continue;
    try {
      const host = new URL(context.url).hostname.replace(/^www\./, "").toLowerCase();
      if (host) sites.add(host);
    } catch {
      continue;
    }
  }
  return [...sites];
}

function contextsOf(input: PiSessionInput): PiBrowserContextRecord[] {
  return [
    ...(input.browserContext ? [input.browserContext] : []),
    ...(input.browserContexts ?? []),
  ];
}

/** The run card a hit publishes: the answer, then the speed receipt marked as no model. */
export function rung0Card(
  chatId: string,
  runId: string,
  prompt: string,
  hit: Rung0Hit,
): Extract<PiSessionEvent, { kind: "run-card" }> {
  const notice = rung0Notice(hit);
  return {
    kind: "run-card",
    card: {
      chatId,
      runId,
      items: [
        { kind: "notice", text: notice.text, detail: `${prompt.slice(0, 200)} — ${notice.detail}` },
        { kind: "receipt", receipt: "speed", durationMs: hit.elapsedMs },
      ],
      wrong: { routeId: hit.routeId, abilityId: hit.abilityId },
    },
  };
}
