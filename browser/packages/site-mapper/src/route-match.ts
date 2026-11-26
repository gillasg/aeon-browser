// Picks a saved route for a prompt: the exact same request, normalized, and nothing else. There
// is no word-overlap scoring and no slot guessing, so a prompt that merely resembles a saved run
// always goes to the model. A hit replays with the values the route was saved with.

import type { Route } from "./route-types.js";

export interface RouteHit {
  route: Route;
  inputs: Record<string, string>;
  score: number;
}

const HOST = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi;

/** Hosts written in the prompt. `shop.test` counts; a bare word does not. */
export function sitesNamed(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(HOST)) {
    const host = (match[1] ?? "").replace(/^www\./, "").toLowerCase();
    if (host && !/^\d/.test(host)) found.add(host);
  }
  return [...found];
}

/** Case, spacing and trailing punctuation do not count; every word and value does. */
export function exactTrigger(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

/** The route saved for exactly this request on this site, if any. */
export function matchSavedRoute(prompt: string, routes: readonly Route[]): RouteHit | undefined {
  const trigger = exactTrigger(prompt);
  if (!trigger) return undefined;
  const route = routes.find((item) => item.trigger !== undefined && item.trigger === trigger);
  return route ? { route, inputs: inputsFor(route), score: 1 } : undefined;
}

/** The values the route was saved with: an exact repeat asks for the same thing. */
export function inputsFor(route: Route): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const input of route.inputs) if (input.example) inputs[input.name] = input.example;
  return inputs;
}
