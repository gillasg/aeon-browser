import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BrowserNotConnected,
  explore,
  listSites,
  repair,
  siteName,
  type ModelLike,
} from "@browser-use-extension/tools/site-to-api";
import { inChat } from "./site-browser.js";

// Background API mapping: sites the agent keeps using in chats get mapped into site_api on their
// own (explore, in a background tab, one site at a time), so later chats call their APIs instead
// of clicking. When calls to a mapped operation fail, it is re-recorded and rebuilt (repair).
// AEON_BACKGROUND_MAPPING=0 turns it off.

const CHATS_BEFORE_MAPPING = 2;
const MAPS_PER_DAY = 5;
const RETRY_AFTER_MS = 7 * 86_400_000;
const REPAIR_AFTER_MS = 3_600_000;
const BACKGROUND = "aeon-background";
// Search engines, sign-in pages and Aeon's own pages are used, not worth mapping.
const SKIP =
  /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+$|^(accounts|login|auth|signin|sso)\.|^(localhost|127\.0\.0\.1)$/i;

interface HostState {
  chats: string[];
  explored?: number;
  result?: string;
}
interface State {
  hosts: Record<string, HostState>;
  explores: number[];
  repairs: Record<string, number>;
}

let config: { file: string; model: () => Promise<ModelLike> } | undefined;
let state: Promise<State> | undefined;
let running: Promise<void> = Promise.resolve();
let busy = false;

const enabled = (): boolean => Boolean(config) && process.env.AEON_BACKGROUND_MAPPING !== "0";

/** Turns background mapping on, keeping its notes in this file. */
export function installSiteMapping(file: string, model: () => Promise<ModelLike>): void {
  config = { file, model };
  state = undefined;
}

function load(): Promise<State> {
  state ??= readFile(config?.file ?? "", "utf8")
    .then((text) => JSON.parse(text) as State)
    .catch(() => ({ hosts: {}, explores: [], repairs: {} }));
  return state;
}

async function save(current: State): Promise<void> {
  if (!config) return;
  await mkdir(dirname(config.file), { recursive: true });
  await writeFile(config.file, JSON.stringify(current));
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !/^https?:/i.test(url)) return undefined;
  try {
    const host = siteName(new URL(url).hostname);
    return SKIP.test(host) ? undefined : host;
  } catch {
    return undefined;
  }
}

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

/** Notes the sites a chat used; maps one in the background once enough chats use it. */
export function noteVisits(chatId: string, urls: string[]): void {
  if (!enabled() || !urls.length) return;
  running = running.then(() => record(chatId, urls)).catch(() => undefined);
}

async function record(chatId: string, urls: string[]): Promise<void> {
  const current = await load();
  for (const host of new Set(urls.map(hostOf).filter((h): h is string => Boolean(h)))) {
    const entry = (current.hosts[host] ??= { chats: [] });
    if (!entry.chats.includes(chatId)) entry.chats = [...entry.chats, chatId].slice(-10);
  }
  await save(current);
  void mapNext();
}

async function nextHost(current: State): Promise<string | undefined> {
  const now = Date.now();
  current.explores = current.explores.filter((at) => now - at < 86_400_000);
  if (current.explores.length >= MAPS_PER_DAY) return undefined;
  const mapped = new Set((await listSites()).map((site) => site.site));
  return Object.entries(current.hosts)
    .filter(([host, entry]) => entry.chats.length >= CHATS_BEFORE_MAPPING && !mapped.has(host))
    .filter(([, entry]) => !entry.explored || now - entry.explored > RETRY_AFTER_MS)
    .sort(([, a], [, b]) => b.chats.length - a.chats.length)[0]?.[0];
}

/** Maps the most used unmapped site, one at a time, in a background tab. */
async function mapNext(): Promise<void> {
  if (busy || !enabled() || !config) return;
  busy = true;
  try {
    const current = await load();
    const host = await nextHost(current);
    if (!host) return;
    current.explores.push(Date.now());
    current.hosts[host] = { ...(current.hosts[host] ?? { chats: [] }), explored: Date.now() };
    await save(current);
    const model = await config.model();
    const [result] = await inChat(BACKGROUND, () => explore([host], { model, parallel: 1 }));
    current.hosts[host] = {
      ...(current.hosts[host] as HostState),
      result: result?.error ?? `${result?.operations ?? 0} operations`,
    };
    await save(current);
  } catch {
    // Mapping is best effort: the browser may be offline or no model connected.
  } finally {
    busy = false;
  }
}

/** A call to a mapped operation failed: re-record and rebuild it in the background. */
export function repairSoon(site: string, operation: string, error: unknown): void {
  if (!enabled() || error instanceof BrowserNotConnected) return;
  const message = error instanceof Error ? error.message : String(error);
  // Missing inputs and unknown operations are the caller's mistake, not the site changing.
  if (/missing|required|unknown operation|not mapped/i.test(message)) return;
  running = running
    .then(async () => {
      const current = await load();
      const key = `${siteName(site)}:${operation}`;
      if (Date.now() - (current.repairs[key] ?? 0) < REPAIR_AFTER_MS) return;
      current.repairs[key] = Date.now();
      await save(current);
      void inChat(BACKGROUND, () => repair(site, [operation])).catch(() => undefined);
    })
    .catch(() => undefined);
}

/** Resolves once noted visits and repair requests have been recorded (for tests). */
export const mappingSettled = (): Promise<void> => running;
