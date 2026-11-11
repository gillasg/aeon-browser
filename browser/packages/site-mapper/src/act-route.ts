// The act cache is a route: one instruction, its steps, replayed with no model. Callers of
// page.act still pass the same steps; the stored form is a route.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { draftCell } from "./route-compile.js";
import type { Route, RouteStep } from "./route-types.js";
import { writeAtomic } from "./registry.js";

export interface ActStep {
  role: string;
  name: string;
  method: string;
  args: string[];
  description: string;
}

interface ActRecord {
  route: Route;
  steps: ActStep[];
  savedAt: number;
}

const FILE = "act-routes.json";
const LIFE = 30 * 24 * 60 * 60 * 1000;

export function actRoute(site: string, instruction: string, steps: readonly ActStep[]): Route {
  const routeSteps = steps.map(routeStep);
  const now = new Date();
  return {
    id: `act-${hashKey(site, instruction)}`,
    site,
    signature: instruction
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 8),
    inputs: actInputs(steps),
    inputHistory: [],
    steps: routeSteps,
    reads: [],
    writes: routeSteps.some((step) => step.kind === "fill"),
    okRuns: 1,
    lastOkAt: now.toISOString(),
    summary: instruction.slice(0, 80),
    cell: draftCell(routeSteps),
    ambiguous: false,
    expiresAt: new Date(now.getTime() + LIFE).toISOString(),
    fingerprint: hashKey(site, instruction),
  };
}

export async function saveActRoute(
  directory: string,
  key: string,
  site: string,
  instruction: string,
  steps: readonly ActStep[],
): Promise<void> {
  if (!steps.length) return;
  const file = await readActs(directory);
  file[key] = {
    route: actRoute(site, instruction, steps),
    steps: steps.map(clean),
    savedAt: Date.now(),
  };
  await writeActs(directory, file);
}

export async function readActRoute(
  directory: string,
  key: string,
): Promise<{ steps: ActStep[]; route: Route } | undefined> {
  const record = (await readActs(directory))[key];
  if (!record || Date.now() - record.savedAt > LIFE) return undefined;
  return { steps: record.steps, route: record.route };
}

export async function dropActRoute(directory: string, key: string): Promise<boolean> {
  const file = await readActs(directory);
  if (!(key in file)) return false;
  delete file[key];
  await writeActs(directory, file);
  return true;
}

function routeStep(step: ActStep): RouteStep {
  const kind = step.method === "type" ? "fill" : step.method;
  const args = storedArgs(step);
  return {
    kind: kind === "check" || kind === "uncheck" || kind === "hover" ? "click" : kind,
    target: {
      role: step.role,
      name: step.name,
      ...(step.description ? { text: step.description } : {}),
    },
    ...(args.length ? { args } : {}),
    onPageType: "",
    expectEffect: "confirmed",
  };
}

function clean(step: ActStep): ActStep {
  return {
    role: step.role,
    name: step.name,
    method: step.method,
    args: storedArgs(step),
    description: step.description,
  };
}

function storedArgs(step: ActStep): string[] {
  return step.args.map((arg) => storedArg(step, arg));
}

function storedArg(step: ActStep, arg: string): string {
  if (secretText(step, arg)) return "{secret}";
  if (step.method === "fill" || step.method === "type" || step.method === "select")
    return "{value}";
  return arg.slice(0, 500);
}

function secretText(step: ActStep, arg: string): boolean {
  return (
    /password|token|secret|cookie/i.test(`${step.name} ${arg}`) ||
    /^[A-Za-z0-9+/=_-]{24,}$/.test(arg)
  );
}

function actInputs(steps: readonly ActStep[]): Route["inputs"] {
  const names = new Set<string>();
  for (const step of steps) {
    for (const arg of step.args) {
      if (secretText(step, arg)) names.add("secret");
      else if (step.method === "fill" || step.method === "type" || step.method === "select")
        names.add("value");
    }
  }
  return [...names].map((name) => ({ name, example: "" }));
}

function hashKey(site: string, instruction: string): string {
  return `${site}:${instruction}`.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

async function readActs(directory: string): Promise<Record<string, ActRecord>> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, FILE), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ActRecord>) : {};
  } catch {
    return {};
  }
}

async function writeActs(directory: string, file: Record<string, ActRecord>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeAtomic(join(directory, FILE), JSON.stringify(file));
}
