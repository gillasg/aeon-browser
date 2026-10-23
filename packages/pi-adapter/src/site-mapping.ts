import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { explore, loadModel, siteName, type ModelLike } from "@browserkit/tools/site-to-api";
import { inChat } from "./site-browser.js";

// Sites learn their APIs while the agent uses them (the learn-live loop in browser code), so
// nothing maps sites in the background on a hunch. One case is the system's to decide: a routine
// or watcher is set up for a site with no learned read. Then the site is explored once, in a
// background tab, looking only, so the routine's checks can call its API instead of a model.

const EXPLORES_PER_DAY = 3;
const RETRY_AFTER_MS = 7 * 86_400_000;
const BACKGROUND = "aeon-background";
// Search engines, sign-in pages and local pages are used, not worth mapping.
const SKIP =
  /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+$|^(accounts|login|auth|signin|sso)\.|^(localhost|127\.0\.0\.1)$/i;
const HOSTS = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:\s'"`)]|$)/gi;

interface State {
  explored: Record<string, number>;
  explores: number[];
}

let config: { file: string; model: () => Promise<ModelLike> } | undefined;
let running: Promise<void> = Promise.resolve();

/** The URLs a browser_code cell opened or moved to. */
export function visitedUrls(steps: Record<string, unknown>[]): string[] {
  const urls: string[] = [];
  for (const step of steps) {
    const action = step.action as { url?: unknown } | undefined;
    const tab = (step.result as { tab?: { url?: unknown } } | undefined)?.tab;
    for (const url of [action?.url, tab?.url]) if (typeof url === "string") urls.push(url);
  }
  return urls;
}

/** Where explore keeps its notes, and the model it browses with. */
export function installSiteMapping(file: string, model: () => Promise<ModelLike>): void {
  config = { file, model };
}

/** Kept for the existing call site; visits are not recorded. */
export function noteVisits(chatId: string, urls: string[]): void {
  void chatId;
  void urls;
}

/** Kept for the existing call site: a failing operation is repaired by the next page run. */
export function repairSoon(site: string, operation: string, error: unknown): void {
  void site;
  void operation;
  void error;
}

/** Resolves when queued explores have finished. */
export const mappingSettled = (): Promise<void> => running;

/** The sites a routine's title, instruction or check names. */
export function routineSites(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(HOSTS)) {
    const host = siteName(match[1] ?? "");
    if (host && !SKIP.test(host) && !/\.(js|ts|json|md|txt|png|jpg)$/i.test(host)) hosts.add(host);
  }
  return [...hosts].slice(0, 2);
}

/**
 * A routine was set up: explore each site it names that has no read operation yet, once, in
 * the background. Best effort; never throws.
 */
export function exploreForRoutine(text: string): void {
  if (!config || process.env.AEON_BACKGROUND_MAPPING === "0") return;
  for (const site of routineSites(text))
    running = running.then(() => exploreOnce(site)).catch(() => undefined);
}

async function exploreOnce(site: string): Promise<void> {
  if (!config) return;
  const model = await loadModel(site).catch(() => undefined);
  if (model?.operations.some((operation) => operation.role === "read")) return;
  const state = await load(config.file);
  const now = Date.now();
  state.explores = state.explores.filter((at) => now - at < 86_400_000);
  if (state.explores.length >= EXPLORES_PER_DAY) return;
  if (now - (state.explored[site] ?? 0) < RETRY_AFTER_MS) return;
  state.explores.push(now);
  state.explored[site] = now;
  await save(config.file, state);
  const browse = await config.model();
  await inChat(BACKGROUND, () => explore([site], { model: browse, parallel: 1 }));
}

async function load(file: string): Promise<State> {
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as Partial<State>;
    return { explored: state.explored ?? {}, explores: state.explores ?? [] };
  } catch {
    return { explored: {}, explores: [] };
  }
}

async function save(file: string, state: State): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}
