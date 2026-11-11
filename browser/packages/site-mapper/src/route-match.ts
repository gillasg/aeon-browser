// Picks a saved route for a prompt. Word overlap only, and only on one site, so a near miss
// stays with the model.

import { contentWords } from "./route-compile.js";
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

/** The closest route on this site, when at least half of its signature words are in the prompt. */
export function matchSavedRoute(prompt: string, routes: readonly Route[]): RouteHit | undefined {
  const words = new Set(contentWords(prompt));
  let best: RouteHit | undefined;
  for (const route of routes) {
    const hit = score(route, words, prompt);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

function score(route: Route, words: Set<string>, prompt: string): RouteHit | undefined {
  if (!route.signature.length) return undefined;
  const hits = route.signature.filter((word) => words.has(word)).length;
  const value = hits / route.signature.length;
  if (hits < 1 || value < 0.5) return undefined;
  return { route, inputs: inputsFor(route, prompt), score: value };
}

/** Slot values for this prompt. A new number replaces the example; anything else must be written out. */
export function inputsFor(route: Route, prompt: string): Record<string, string> {
  const numbers = [...prompt.matchAll(/\b\d{2,}\b/g)].map((match) => match[0] ?? "");
  const inputs: Record<string, string> = {};
  for (const input of route.inputs) {
    const value = valueFor(input.example, prompt, numbers);
    if (value) inputs[input.name] = value;
  }
  return inputs;
}

function valueFor(example: string, prompt: string, numbers: string[]): string | undefined {
  if (!example) return undefined;
  if (prompt.includes(example)) return example;
  if (!/^\d+$/.test(example)) return undefined;
  return numbers.find((value) => value !== example) ?? numbers[0];
}
