// Rung 0 is an exact replay with no model. Writes wait for two successes. Anything ambiguous,
// or any missing input, starts at rung 1 with the old run as a draft.

import type { Route, RouteDraft, RouteStep } from "./types.js";

export function replayRung(route: Route, inputs: Record<string, string>): 0 | 1 {
  if (route.ambiguous || !mapsExactly(route, inputs)) return 1;
  if (route.writes && route.okRuns < 2) return 1;
  return 0;
}

export function mapsExactly(route: Route, inputs: Record<string, string>): boolean {
  return route.inputs.every((input) => {
    const value = inputs[input.name];
    return typeof value === "string" && value.length > 0;
  });
}

export function memoryLine(ranAt: string): string {
  const date = new Date(ranAt);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  return `via memory · run of ${date.getUTCDate()} ${month ?? ""}`.trim();
}

export function freshOffer(): { text: "Do it fresh"; action: "fresh" } {
  return { text: "Do it fresh", action: "fresh" };
}

/** The FirstTurn `routeDraft` field. Only rung 1 starts carry it. */
export function routeDraft(route: Route, rung: 0 | 1): RouteDraft | undefined {
  if (rung !== 1) return undefined;
  return {
    site: route.site,
    summary: route.summary || route.signature.join(" "),
    cell: route.cell || "",
    ranAt: route.lastOkAt,
  };
}

export function fillStep(step: RouteStep, inputs: Record<string, string>): RouteStep {
  return {
    ...step,
    ...(step.args ? { args: step.args.map((arg) => fill(arg, inputs)) } : {}),
    ...(step.target
      ? {
          target: {
            ...step.target,
            ...(step.target.name ? { name: fill(step.target.name, inputs) } : {}),
            ...(step.target.text ? { text: fill(step.target.text, inputs) } : {}),
          },
        }
      : {}),
  };
}

export function missingInput(step: RouteStep): string | undefined {
  const blobs = [step.args?.join(" ") ?? "", step.target?.name ?? "", step.target?.text ?? ""];
  const hole = blobs.join(" ").match(/\{([A-Za-z_][A-Za-z0-9_]*)\}/);
  return hole ? hole[1] : undefined;
}

function fill(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const value = inputs[name];
    return value === undefined ? whole : value;
  });
}
