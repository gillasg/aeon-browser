// Guards run before the step. A miss stops the replay and returns what ran, the state now and
// the steps still left, so the model can continue from there (rung 1).

import type { StepEffect, StepEvent } from "@browserkit/protocol";
import { matchControl } from "./match.js";
import { fillStep, missingInput } from "./rung.js";
import type { ReplayHost, ReplayResult, Route, RouteStep } from "./types.js";

const RANK: Record<string, number> = {
  refused: 0,
  suspected_noop: 1,
  unverifiable: 2,
  confirmed: 3,
};

export async function replay(
  route: Route,
  inputs: Record<string, string>,
  host: ReplayHost,
): Promise<ReplayResult> {
  const ran: StepEvent[] = [];
  const outputs: unknown[] = [];
  for (let index = 0; index < route.steps.length; index++) {
    const step = fillStep(route.steps[index] ?? emptyStep(), inputs);
    const why = await blocked(step, host);
    if (why) return stop(index, why, await host.state(), route.steps.slice(index), ran);
    const done = await host.act(step);
    ran.push(done.event);
    if (done.output !== undefined) outputs.push(done.output);
    const after = afterStep(step, done.effect, done.event);
    if (after) return stop(index + 1, after, await host.state(), route.steps.slice(index + 1), ran);
  }
  return { done: true, outputs, steps: ran };
}

async function blocked(step: RouteStep, host: ReplayHost): Promise<string | undefined> {
  const hole = missingInput(step);
  if (hole) return `input {${hole}} is missing`;
  const page = await host.pageType();
  if (step.onPageType && page && page !== step.onPageType)
    return `page type ${page} is not ${step.onPageType}`;
  if (!step.target || !hasTarget(step.target)) return undefined;
  const control = matchControl(step.target, await host.controls());
  return control ? undefined : "target did not resolve";
}

function afterStep(step: RouteStep, effect: StepEffect, event: StepEvent): string | undefined {
  if (weaker(effect, step.expectEffect))
    return `effect ${effect} is weaker than ${step.expectEffect ?? "unverifiable"}`;
  if (!step.expectRequest) return undefined;
  const request = event.evidence?.request;
  if (
    !request ||
    request.method !== step.expectRequest.method ||
    request.path !== step.expectRequest.path
  )
    return "expected request did not happen";
  return undefined;
}

function weaker(actual: string | undefined, expected: string | undefined): boolean {
  return (RANK[actual ?? "unverifiable"] ?? 2) < (RANK[expected ?? "unverifiable"] ?? 2);
}

function hasTarget(target: RouteStep["target"]): boolean {
  return Boolean(target?.role || target?.name || target?.css || target?.text);
}

function stop(
  at: number,
  why: string,
  state: string,
  remaining: RouteStep[],
  steps: StepEvent[],
): ReplayResult {
  return { done: false, at, why, state, remaining, steps };
}

function emptyStep(): RouteStep {
  return { kind: "read", onPageType: "", expectEffect: "unverifiable" };
}
