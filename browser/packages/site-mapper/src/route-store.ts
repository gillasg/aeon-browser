// Routes are private, local and expiring. A run waits a few minutes before it is trusted, so a
// correction in that window drops it and the corrected path never becomes a route.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileRoute, type CompileInput } from "./route-compile.js";
import type { Route } from "./route-types.js";
import { siteDir, siteName, writeAtomic } from "./registry.js";
import { rememberRun, type RunKnowledge } from "./site-knowledge.js";
import { saveSiteNote } from "./site-notes.js";

const FILE = "routes.json";
const SETTLE_MS = 3 * 60 * 1000;
const writes = new Map<string, Promise<unknown>>();

interface Pending {
  route: Route;
  stagedAt: string;
}

interface FileShape {
  routes: Route[];
  pending: Pending[];
  blocked: string[];
}

export interface StageInput extends CompileInput {
  knowledge?: RunKnowledge;
  watcher?: boolean;
}

export interface StageResult {
  status: "pending" | "blocked" | "skipped";
  route?: Route;
  reason?: string;
}

export function stageRun(input: StageInput): Promise<StageResult> {
  return serialised(input.site, () => stageUnlocked(input));
}

async function stageUnlocked(input: StageInput): Promise<StageResult> {
  if (input.knowledge) await rememberRun(input.site, input.knowledge);
  const compiled = compileRoute(input);
  if (!compiled.ok && compiled.reason === "correction") {
    await blockUnlocked(input.site, compiled.fingerprint, compiled.pageType, compiled.quirk);
    return { status: "blocked", reason: "correction" };
  }
  if (!compiled.ok) return { status: "skipped", reason: compiled.reason };
  if (input.watcher) compiled.route.watcher = true;
  const file = await readFileOf(input.site);
  if (file.blocked.includes(compiled.route.fingerprint))
    return { status: "blocked", reason: "corrected-path" };
  const merged = mergePending(file, compiled.route, input.now ?? new Date());
  await writeFileOf(input.site, merged.file);
  return { status: "pending", route: merged.route };
}

/** Pending runs with no correction become routes. `now` is the clock, so tests need not wait. */
export function settleRoutes(site: string, now = new Date()): Promise<Route[]> {
  return serialised(site, () => settleUnlocked(site, now));
}

async function settleUnlocked(site: string, now: Date): Promise<Route[]> {
  const file = await readFileOf(site);
  const ready: Route[] = [];
  const pending: Pending[] = [];
  for (const item of file.pending) {
    if (now.getTime() - Date.parse(item.stagedAt) < SETTLE_MS) pending.push(item);
    else ready.push(item.route);
  }
  const routes = ready.reduce((list, route) => mergeRoute(list, route), file.routes);
  await writeFileOf(site, { ...file, routes, pending });
  return ready.map(
    (route) => routes.find((item) => item.fingerprint === route.fingerprint) ?? route,
  );
}

export async function listRoutes(site: string, now = new Date()): Promise<Route[]> {
  const file = await readFileOf(site);
  return file.routes.filter((route) => Date.parse(route.expiresAt) > now.getTime());
}

export async function readRoute(site: string, id: string): Promise<Route | undefined> {
  return (await listRoutes(site)).find((route) => route.id === id);
}

export function dropRoute(site: string, id: string): Promise<boolean> {
  return serialised(site, () => dropUnlocked(site, id));
}

async function dropUnlocked(site: string, id: string): Promise<boolean> {
  const file = await readFileOf(site);
  const route =
    file.pending.find((item) => item.route.id === id)?.route ??
    file.routes.find((item) => item.id === id);
  if (!route) return false;
  const pageType = route.steps.find((step) => step.onPageType)?.onPageType || "correction";
  await blockUnlocked(site, route.fingerprint, pageType, "corrected: wrong");
  return true;
}

/** Drops one pending run. The fingerprint stays usable, so a later success can still be saved. */
export function cancelPending(site: string, fingerprint: string): Promise<boolean> {
  return serialised(site, () => cancelUnlocked(site, fingerprint));
}

async function cancelUnlocked(site: string, fingerprint: string): Promise<boolean> {
  const file = await readFileOf(site);
  const pending = file.pending.filter((item) => item.route.fingerprint !== fingerprint);
  if (pending.length === file.pending.length) return false;
  await writeFileOf(site, { ...file, pending });
  return true;
}

export function saveRouteEdits(site: string, route: Route): Promise<void> {
  return serialised(site, () => saveEditsUnlocked(site, route));
}

async function saveEditsUnlocked(site: string, route: Route): Promise<void> {
  const file = await readFileOf(site);
  const routes = file.routes.map((item) => (item.id === route.id ? route : item));
  if (!routes.some((item) => item.id === route.id)) routes.push(route);
  await writeFileOf(site, { ...file, routes });
}

async function blockUnlocked(
  site: string,
  fingerprint: string,
  pageType: string,
  quirk: string,
): Promise<void> {
  const file = await readFileOf(site);
  const blocked = file.blocked.includes(fingerprint)
    ? file.blocked
    : [...file.blocked, fingerprint];
  await writeFileOf(site, {
    routes: file.routes.filter((route) => route.fingerprint !== fingerprint),
    pending: file.pending.filter((item) => item.route.fingerprint !== fingerprint),
    blocked,
  });
  await saveSiteNote(site, {
    kind: "quirk",
    key: pageType.slice(0, 40) || "correction",
    value: quirk,
  });
}

function mergePending(file: FileShape, route: Route, now: Date): { file: FileShape; route: Route } {
  const rest = file.pending.filter((item) => item.route.fingerprint !== route.fingerprint);
  const prior = file.pending.find((item) => item.route.fingerprint === route.fingerprint)?.route;
  const next = prior ? combine(prior, route) : route;
  return {
    file: { ...file, pending: [...rest, { route: next, stagedAt: now.toISOString() }] },
    route: next,
  };
}

function mergeRoute(routes: Route[], route: Route): Route[] {
  const index = routes.findIndex((item) => item.fingerprint === route.fingerprint);
  if (index < 0) return [...routes, route];
  const prior = routes[index];
  if (!prior) return routes;
  const next = [...routes];
  next[index] = combine(prior, route);
  return next;
}

export function combine(prior: Route, next: Route): Route {
  const history = uniqueHistory([...prior.inputHistory, ...next.inputHistory]);
  return {
    ...next,
    id: prior.id,
    okRuns: prior.okRuns + next.okRuns,
    inputHistory: history,
    abilityId: prior.abilityId,
    watcher: prior.watcher || next.watcher,
    expiresAt: next.expiresAt,
  };
}

function uniqueHistory(history: Record<string, string>[]): Record<string, string>[] {
  const seen = new Set<string>();
  const kept: Record<string, string>[] = [];
  for (const item of history) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept.slice(-8);
}

function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = writes.get(key) ?? Promise.resolve();
  const next = prior.then(work, work);
  writes.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function readFileOf(site: string): Promise<FileShape> {
  try {
    const parsed = JSON.parse(await readFile(pathOf(site), "utf8")) as Partial<FileShape>;
    return {
      routes: Array.isArray(parsed.routes) ? parsed.routes : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
    };
  } catch {
    return { routes: [], pending: [], blocked: [] };
  }
}

async function writeFileOf(site: string, file: FileShape): Promise<void> {
  const folder = siteDir(siteName(site));
  await mkdir(folder, { recursive: true });
  await writeAtomic(pathOf(site), JSON.stringify(file, null, 2) + "\n");
}

function pathOf(site: string): string {
  return join(siteDir(siteName(site)), FILE);
}
