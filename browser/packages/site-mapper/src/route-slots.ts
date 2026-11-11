// A prompt value that shows up in a step argument or target becomes a slot. Two candidates
// for one slot is ambiguity: no slot, and the run stays on rung 1.

import type { ObservedStep, RouteInput, RouteStep, TargetWithFallbacks } from "./route-types.js";

const STOP = new Set(
  "a an the to for of on in my me please show get find all and or with from this that your you i it is are was be at by".split(
    " ",
  ),
);

export interface SlotResult {
  steps: RouteStep[];
  inputs: RouteInput[];
  ambiguous: boolean;
  reads: string[];
  writes: boolean;
}

interface Candidate {
  value: string;
  name: string;
  secret: boolean;
}

export function inferSlots(prompt: string, observed: readonly ObservedStep[]): SlotResult {
  const candidates = promptValues(prompt);
  const placed = place(candidates, observed);
  return {
    steps: placed.steps,
    inputs: placed.inputs,
    ambiguous: placed.ambiguous,
    reads: observed.filter(isRead).map((step) => step.id),
    writes: observed.some((step) => step.write === true),
  };
}

function place(
  candidates: Candidate[],
  observed: readonly ObservedStep[],
): { steps: RouteStep[]; inputs: RouteInput[]; ambiguous: boolean } {
  const used = new Map<string, Candidate>();
  let ambiguous = false;
  const steps = observed.map((step) => {
    const hit = fillStep(step, candidates);
    if (hit.ambiguous) ambiguous = true;
    for (const candidate of hit.used) noteCandidate(used, candidate, () => (ambiguous = true));
    return hit.step;
  });
  if (ambiguous)
    return {
      steps: observed.map((step) => redactStep(step, candidates)),
      inputs: [],
      ambiguous: true,
    };
  return { steps, inputs: [...used.values()].map(inputOf), ambiguous: false };
}

function noteCandidate(
  used: Map<string, Candidate>,
  candidate: Candidate,
  clash: () => void,
): void {
  const prior = used.get(candidate.name);
  if (prior && prior.value !== candidate.value) clash();
  else used.set(candidate.name, candidate);
}

function fillStep(
  step: ObservedStep,
  candidates: Candidate[],
): { step: RouteStep; used: Candidate[]; ambiguous: boolean } {
  const args = step.args ?? [];
  const used: Candidate[] = [];
  let ambiguous = false;
  const nextArgs = args.map((arg) => {
    const hits = hitsIn(arg, candidates, step.sensitive === true);
    if (hits.length > 1) {
      ambiguous = true;
      return arg;
    }
    const only = hits[0];
    if (!only) return arg;
    used.push(only);
    return arg.split(only.value).join(token(only));
  });
  const target = fillTarget(step.target, candidates, used);
  if (target.ambiguous) ambiguous = true;
  return { step: toRouteStep(step, nextArgs, target.target), used, ambiguous };
}

function fillTarget(
  target: TargetWithFallbacks | undefined,
  candidates: Candidate[],
  used: Candidate[],
): { target?: TargetWithFallbacks; ambiguous: boolean } {
  if (!target?.name) return { target, ambiguous: false };
  const hits = hitsIn(target.name, candidates, false).filter(specific);
  if (hits.length > 1) return { target, ambiguous: true };
  const only = hits[0];
  if (!only) return { target, ambiguous: false };
  used.push(only);
  return {
    target: { ...target, name: target.name.split(only.value).join(token(only)) },
    ambiguous: false,
  };
}

function hitsIn(text: string, candidates: Candidate[], sensitive: boolean): Candidate[] {
  const found = candidates.filter((candidate) => text.includes(candidate.value));
  if (sensitive) return found.length ? found : [secretCandidate(text)];
  return found;
}

function secretCandidate(text: string): Candidate {
  return { value: text, name: "secret", secret: true };
}

function specific(candidate: Candidate): boolean {
  return candidate.secret || /^\d{2,}/.test(candidate.value) || candidate.value.includes("-");
}

function token(candidate: Candidate): string {
  return `{${candidate.name}}`;
}

function inputOf(candidate: Candidate): RouteInput {
  return { name: candidate.name, example: candidate.secret ? "" : candidate.value };
}

function promptValues(prompt: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of prompt.matchAll(/"([^"]{1,80})"|'([^']{1,80})'/g)) {
    const value = match[1] || match[2] || "";
    if (value) found.push(candidate(prompt, match.index ?? 0, value));
  }
  for (const match of prompt.matchAll(/\b(\d{2,}|[0-9]{4}-[0-9]{2}-[0-9]{2})\b/g)) {
    const value = match[1] ?? "";
    if (value && !found.some((item) => item.value === value))
      found.push(candidate(prompt, match.index ?? 0, value));
  }
  return found;
}

function candidate(prompt: string, index: number, value: string): Candidate {
  return { value, name: slotName(prompt, index), secret: looksSecret(value) };
}

function slotName(prompt: string, index: number): string {
  const before = prompt.slice(0, index).trim().split(/\s+/).pop() ?? "";
  const name = before.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!name || STOP.has(name)) return "value";
  return name.slice(0, 24);
}

function looksSecret(value: string): boolean {
  return /password|token|secret|cookie/i.test(value) || /^[A-Za-z0-9+/=_-]{24,}$/.test(value);
}

function redactStep(step: ObservedStep, candidates: Candidate[]): RouteStep {
  const args = (step.args ?? []).map((arg) => redactArg(step, arg));
  return toRouteStep(step, args, redactTarget(step.target, candidates));
}

function redactArg(step: ObservedStep, arg: string): string {
  if (step.sensitive === true || looksSecret(arg)) return "{secret}";
  if (step.kind === "fill" || step.kind === "type" || step.kind === "select") return "{value}";
  return arg;
}

function redactTarget(
  target: TargetWithFallbacks | undefined,
  candidates: Candidate[],
): TargetWithFallbacks | undefined {
  if (!target) return target;
  const name = scrub(target.name, candidates);
  const text = scrub(target.text, candidates);
  if (name === target.name && text === target.text) return target;
  return {
    ...target,
    ...(name !== undefined ? { name } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

function scrub(text: string | undefined, candidates: Candidate[]): string | undefined {
  if (text === undefined) return undefined;
  const ordered = [...candidates].sort((left, right) => right.value.length - left.value.length);
  let next = text;
  for (const candidate of ordered) {
    if (!candidate.value || !next.includes(candidate.value)) continue;
    const token = candidate.secret || looksSecret(candidate.value) ? "{secret}" : "{value}";
    next = next.split(candidate.value).join(token);
  }
  return looksSecret(next) ? "{secret}" : next;
}

function toRouteStep(
  step: ObservedStep,
  args: string[],
  target: TargetWithFallbacks | undefined,
): RouteStep {
  const request = step.evidence?.request;
  return {
    kind: step.kind,
    ...(target && hasTarget(target) ? { target } : {}),
    ...(args.length ? { args } : {}),
    onPageType: step.pageType || pageTypeOf(step.url),
    expectEffect: step.effect || "unverifiable",
    ...(request ? { expectRequest: { method: request.method, path: request.path } } : {}),
  };
}

function hasTarget(target: TargetWithFallbacks): boolean {
  return Boolean(target.role || target.name || target.css || target.text);
}

function pageTypeOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname.split("/").filter(Boolean).slice(0, 2).join("-") || "page";
  } catch {
    return "";
  }
}

function isRead(step: ObservedStep): boolean {
  return step.kind === "read" || step.kind === "api" || step.evidence?.valueRead === true;
}
