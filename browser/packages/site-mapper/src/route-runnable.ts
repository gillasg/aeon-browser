// A promoted route must run with no model. Each way built here is executable: a call to the
// site's mapped API when the route's read went through one, else a deterministic browser script
// from its steps. Slots stay typed placeholders (`{{inputs.year}}` in API params, `inputs.year` in
// scripts). A way that fails its syntax or schema check is never saved.

import { Script } from "node:vm";
import type { AbilityWay, AbilityWayApi, AbilityWayScript } from "./abilities.js";
import { operationInputs } from "./params.js";
import type { Route, RouteStep, TargetWithFallbacks } from "./route-types.js";
import type { Operation, SiteModel } from "./types.js";

const NAVIGATE = /^(navigate|goto|open)$/;
const CLICK = /^(click|check|uncheck|tap)$/;
/** Steps that only looked: the script reads the page at the end anyway. */
const LOOK = /^(read|extract|scroll|wait|hover|api|screenshot|snapshot|observe)$/;
const SLOT = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The executable ways for a route, best first. Empty when nothing in it can run unattended. */
export function runnableWays(route: Route, model?: SiteModel): AbilityWay[] {
  const ways: AbilityWay[] = [];
  const api = route.writes ? undefined : apiWayFor(route, model);
  if (api && !wayProblem(api, route, model)) ways.push(api);
  const script = scriptWayFor(route);
  if (script && !wayProblem(script, route, model)) ways.push(script);
  return ways;
}

/**
 * The read-only API call a route made, mapped to the site model's operation. Each slot must land
 * in one of the operation's inputs, or the call would ignore what the user asked for.
 */
export function apiWayFor(route: Route, model: SiteModel | undefined): AbilityWayApi | undefined {
  if (!model) return undefined;
  const requests = route.steps.flatMap((step) => (step.expectRequest ? [step.expectRequest] : []));
  for (const request of requests.reverse()) {
    const operation = model.operations.find(
      (item) => item.role === "read" && matchesRequest(item, request.method, request.path),
    );
    if (!operation) continue;
    const params = apiParams(route, operation, request.path);
    if (params) return { kind: "api", operation: operation.id, params };
  }
  return undefined;
}

function matchesRequest(operation: Operation, method: string, path: string): boolean {
  if (operation.method.toUpperCase() !== method.toUpperCase()) return false;
  return templatePattern(operation.path).test(pathOnly(path));
}

function pathOnly(path: string): string {
  try {
    return new URL(path, "https://x").pathname;
  } catch {
    return path.split("?")[0] ?? path;
  }
}

function templatePattern(template: string): RegExp {
  const escaped = template
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("([^/]+)");
  return new RegExp(`^${escaped}/?$`);
}

function recordedValues(operation: Operation, path: string): Map<string, string> {
  const values = new Map<string, string>();
  const names = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
  const found = templatePattern(operation.path).exec(pathOnly(path));
  names.forEach((name, index) => {
    const value = found?.[index + 1];
    if (value !== undefined) values.set(name, decodeURIComponent(value));
  });
  try {
    for (const [key, value] of new URL(path, "https://x").searchParams) values.set(key, value);
  } catch {
    // A path with no query.
  }
  return values;
}

function apiParams(
  route: Route,
  operation: Operation,
  path: string,
): Record<string, unknown> | undefined {
  const recorded = recordedValues(operation, path);
  const inputs = operationInputs(operation);
  const params: Record<string, unknown> = {};
  const placed = new Set<string>();
  for (const name of inputs) {
    const value = recorded.get(name);
    if (value === undefined) continue;
    const slot = route.inputs.find((input) => input.example && input.example === value);
    if (slot) {
      params[name] = `{{inputs.${slot.name}}}`;
      placed.add(slot.name);
    } else if (operation.params.find((param) => param.name === name)?.required)
      params[name] = value;
  }
  const missing = operation.params.filter(
    (param) =>
      param.required &&
      inputs.includes(param.name) &&
      param.constant === undefined &&
      !(param.name in params),
  );
  if (missing.length) return undefined;
  return route.inputs.every((input) => placed.has(input.name)) ? params : undefined;
}

/** A browser script that repeats the route's steps, then reads the page it ended on. */
export function scriptWayFor(route: Route): AbilityWayScript | undefined {
  const lines: string[] = [];
  for (const step of route.steps) {
    const line = stepLine(step);
    if (line === undefined) return undefined;
    if (line) lines.push(line);
  }
  if (!lines.some((line) => line.includes("page.goto("))) return undefined;
  const body = [
    "  const fill = (text) => String(text).replace(/\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (whole, name) => (inputs && name in inputs ? String(inputs[name]) : whole));",
    ...lines.map((line) => `  ${line}`),
    route.writes
      ? "  return { done: true, url: await page.url() };"
      : "  const read = await page.read();\n  return { result: read.text, url: read.url };",
  ];
  return {
    kind: "script",
    runtime: "page",
    code: `async (page, bu, inputs) => {\n${body.join("\n")}\n}`,
  };
}

/** One line of browser code, "" for a step that only looked, undefined for one it cannot repeat. */
export function stepLine(step: RouteStep): string | undefined {
  if (NAVIGATE.test(step.kind)) return gotoLine(step.url ?? step.args?.[0]);
  if (LOOK.test(step.kind)) return "";
  const locator = locatorCode(step.target);
  if (!locator) return undefined;
  if (CLICK.test(step.kind)) return `await ${locator}.click();`;
  const value = step.args?.[0];
  const method = VALUE_METHOD[step.kind];
  if (!method || value === undefined || isSecretSlot(value)) return undefined;
  return `await ${locator}.${method}(fill(${text(value)}));`;
}

const VALUE_METHOD: Record<string, string> = {
  fill: "fill",
  type: "fill",
  select: "selectOption",
  press: "press",
};

function gotoLine(url: string | undefined): string | undefined {
  return url && /^https?:\/\//.test(url) ? `await page.goto(fill(${text(url)}));` : undefined;
}

/** A saved secret placeholder never replays: the value was never kept. */
function isSecretSlot(value: string): boolean {
  return value.includes("{secret}");
}

function locatorCode(target: TargetWithFallbacks | undefined): string | undefined {
  if (!target) return undefined;
  if (target.role && target.name)
    return `page.getByRole(${text(target.role)}, { name: fill(${text(target.name)}) }).first()`;
  if (target.css) return `page.locator(${text(target.css)}).first()`;
  if (target.text) return `page.getByText(fill(${text(target.text)})).first()`;
  return undefined;
}

function text(value: string): string {
  return JSON.stringify(value);
}

/** Why a way cannot be saved: bad syntax, an unknown operation, or a slot no input declares. */
export function wayProblem(way: AbilityWay, route: Route, model?: SiteModel): string | undefined {
  const declared = new Set(route.inputs.map((input) => input.name));
  if (way.kind === "script") return scriptProblem(way.code, declared);
  if (way.kind === "api") return apiProblem(way, declared, model);
  return undefined;
}

function scriptProblem(code: string, declared: Set<string>): string | undefined {
  try {
    new Script(`(${code})`);
  } catch (error) {
    return `script does not parse: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (const match of code.matchAll(SLOT)) {
    const name = match[1] ?? "";
    if (!declared.has(name)) return `script uses {${name}}, which no input declares`;
  }
  return undefined;
}

function apiProblem(
  way: AbilityWayApi,
  declared: Set<string>,
  model: SiteModel | undefined,
): string | undefined {
  const operation = model?.operations.find((item) => item.id === way.operation);
  if (!operation) return `operation ${way.operation ?? ""} is not in the site model`;
  for (const value of Object.values(way.params ?? {})) {
    const slot = /^\{\{inputs\.([A-Za-z0-9_]+)\}\}$/.exec(String(value))?.[1];
    if (slot && !declared.has(slot)) return `param uses ${slot}, which no input declares`;
  }
  return undefined;
}
