import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { explore, loadModel, siteName, type ModelLike } from "@browserkit/tools/site-to-api";
import { inChat } from "./site-browser.js";

// Sites learn their APIs while the agent uses them (the learn-live loop in browser code), so
// nothing maps sites in the background on a hunch. Two cases are the system's to decide:
// - a site the user works with in two chats is explored once, in a background tab, looking only,
//   so later work can call its API instead of reading pages;
// - a routine or watcher set up for a site with no learned read gets that site explored, so its
//   checks can call the site's API instead of a model.
// One explore at a time, five a day. A failed one keeps a short reason and is tried again a week
// later: an error never makes a site permanently done.

const EXPLORES_PER_DAY = 5;
const RETRY_AFTER_MS = 7 * 86_400_000;
const CHATS_PER_SITE = 2;
const BACKGROUND = "aeon-background";
const MAX_CHATS = 20;
const MAX_REASON = 200;
// Search engines, sign-in pages and local pages are used, not worth mapping.
const SKIP =
  /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+$|^(accounts|login|auth|signin|sso)\.|^(localhost|127\.0\.0\.1)$/i;
const HOSTS = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:\s'"`)]|$)/gi;

interface HostState {
  /** The chats that used this host. */
  chats: string[];
  /** When its last explore started. */
  explored?: number;
  /** What the last explore found, when it worked. */
  result?: string;
  /** Why the last explore failed. */
  error?: string;
}

interface State {
  hosts: Record<string, HostState>;
  /** Explore starts in the last day. */
  explores: number[];
}

interface Config {
  file: string;
  model: () => Promise<ModelLike>;
}

interface Outcome {
  result?: string;
  error?: string;
}

let config: Config | undefined;
/** State changes, one at a time, so a visit cannot overwrite an attempt mark. */
let writing: Promise<unknown> = Promise.resolve();
/** Visits and the explores they schedule. */
let visiting: Promise<void> = Promise.resolve();
/** Explores, one at a time. */
let exploring: Promise<void> = Promise.resolve();
/** Hosts tracked by an earlier version have been looked at since mapping was installed. */
let caughtUp = false;

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
  caughtUp = false;
}

/** Kept for the existing call site; visits are recorded by noteVisits. */
export function noteVisits(chatId: string, urls: string[]): void {
  if (!config || mappingOff()) return;
  const hosts = [...new Set(urls.map(hostOf).filter((host): host is string => !!host))];
  if (!hosts.length) return;
  const current = config;
  visiting = visiting
    .then(async () => {
      // State written by earlier versions tracked hosts but nothing read it back. Catch up the
      // first time the browser is really in use, not while the daemon is still starting.
      if (!caughtUp) {
        caughtUp = true;
        await catchUp(current);
      }
      const eligible = await mutate(current, (state) => recordVisit(state, chatId, hosts));
      for (const site of eligible) queueExplore(site);
    })
    .catch(() => undefined);
}

/** Kept for the existing call site: a failing operation is repaired by the next page run. */
export function repairSoon(site: string, operation: string, error: unknown): void {
  void site;
  void operation;
  void error;
}

/** Resolves when queued visits and explores have finished. */
export async function mappingSettled(): Promise<void> {
  await visiting;
  await exploring;
  await writing;
}

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
  if (!config || mappingOff()) return;
  for (const site of routineSites(text)) queueExplore(site);
}

function mappingOff(): boolean {
  return process.env.AEON_BACKGROUND_MAPPING === "0";
}

/** `https://www.shop.example/x` → `shop.example`, unless it is a search or sign-in host. */
function hostOf(url: string): string | undefined {
  try {
    const host = siteName(new URL(url).hostname);
    return host && !SKIP.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

async function catchUp(current: Config): Promise<void> {
  if (mappingOff()) return;
  const state = await load(current.file);
  const now = Date.now();
  for (const [site, entry] of Object.entries(state.hosts))
    if (entry.chats.length >= CHATS_PER_SITE && !recentlyExplored(entry, now)) queueExplore(site);
}

/** Records the chats that used each host; returns the hosts now worth exploring. */
function recordVisit(state: State, chatId: string, hosts: string[]): string[] {
  const now = Date.now();
  const eligible: string[] = [];
  for (const host of hosts) {
    const entry = (state.hosts[host] ??= { chats: [] });
    if (!entry.chats.includes(chatId)) entry.chats.push(chatId);
    if (entry.chats.length > MAX_CHATS) entry.chats = entry.chats.slice(-MAX_CHATS);
    if (entry.chats.length >= CHATS_PER_SITE && !recentlyExplored(entry, now)) eligible.push(host);
  }
  return eligible;
}

function recentlyExplored(entry: HostState, now: number): boolean {
  return now - (entry.explored ?? 0) < RETRY_AFTER_MS;
}

function queueExplore(site: string): void {
  exploring = exploring.then(() => exploreOnce(site)).catch(() => undefined);
}

async function exploreOnce(site: string): Promise<void> {
  if (!config || SKIP.test(site)) return;
  const current = config;
  const model = await loadModel(site).catch(() => undefined);
  if (model?.operations.some((operation) => operation.role === "read")) return;
  const now = Date.now();
  if (!(await mutate(current, (state) => startExplore(state, site, now)))) return;
  const outcome = await runExplore(current, site);
  await mutate(current, (state) => finishExplore(state, site, now, outcome)).catch(() => undefined);
}

/** Claims today's slot and marks the attempt; false when the site must wait. */
function startExplore(state: State, site: string, now: number): boolean {
  state.explores = state.explores.filter((at) => now - at < 86_400_000);
  const entry = (state.hosts[site] ??= { chats: [] });
  if (state.explores.length >= EXPLORES_PER_DAY || recentlyExplored(entry, now)) return false;
  state.explores.push(now);
  entry.explored = now;
  delete entry.result;
  delete entry.error;
  return true;
}

function finishExplore(state: State, site: string, at: number, outcome: Outcome): void {
  const entry = (state.hosts[site] ??= { chats: [] });
  entry.explored = at;
  delete entry.result;
  delete entry.error;
  if (outcome.error) entry.error = outcome.error;
  else if (outcome.result) entry.result = outcome.result;
}

async function runExplore(current: Config, site: string): Promise<Outcome> {
  try {
    const browse = await current.model();
    const [found] = await inChat(BACKGROUND, () => explore([site], { model: browse, parallel: 1 }));
    if (!found) return { error: "explore returned no result" };
    if (found.error) return { error: reason(found.error) };
    const operations = found.operations ?? 0;
    return { result: `${operations} operation${operations === 1 ? "" : "s"}` };
  } catch (error) {
    return { error: reason(error instanceof Error ? error.message : String(error)) };
  }
}

/** One line, short enough to read in the state file and in a report. */
function reason(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "explore failed";
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

/** Reads, changes and writes the state as one step. */
function mutate<T>(current: Config, change: (state: State) => T): Promise<T> {
  const result = writing.then(async () => {
    const state = await load(current.file);
    const value = change(state);
    await save(current.file, state);
    return value;
  });
  writing = result.catch(() => undefined);
  return result;
}

interface StoredState extends Partial<State> {
  /** Earlier versions kept the last attempt at the top level. */
  explored?: Record<string, number>;
}

async function load(file: string): Promise<State> {
  let stored: StoredState;
  try {
    stored = JSON.parse(await readFile(file, "utf8")) as StoredState;
  } catch {
    return { hosts: {}, explores: [] };
  }
  const hosts: Record<string, HostState> = {};
  for (const [site, value] of Object.entries(stored.hosts ?? {})) hosts[site] = hostState(value);
  for (const [site, at] of Object.entries(stored.explored ?? {})) {
    if (typeof at !== "number") continue;
    (hosts[site] ??= { chats: [] }).explored ??= at;
  }
  return {
    hosts,
    explores: Array.isArray(stored.explores)
      ? stored.explores.filter((at): at is number => typeof at === "number")
      : [],
  };
}

function hostState(value: unknown): HostState {
  const record = (value ?? {}) as Partial<HostState>;
  const entry: HostState = {
    chats: Array.isArray(record.chats)
      ? record.chats.filter((chat): chat is string => typeof chat === "string")
      : [],
  };
  if (typeof record.explored === "number") entry.explored = record.explored;
  if (typeof record.result === "string") entry.result = record.result;
  if (typeof record.error === "string") entry.error = record.error;
  return entry;
}

async function save(file: string, state: State): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}
