import {
  createHostHandler,
  type HostRequestContext,
  type HostSiteRules,
} from "@browserkit/tools/host";
import type { ModelLike } from "@browserkit/tools/site-to-api";

// Graft's side of the one host handler: credentials, site rules and mapped-site calls are
// browserkit's; Graft adds only its own storage (workspace, site skills, saved reads) through
// `extra`. `source` decides whether a typed-user `allow` may lift a block; routines, checks and
// outside sessions always get `allow: []`.

export type { HostRequestContext };

export type SiteRulesAnswer = HostSiteRules;

export type SiteRulesProvider = (scope: string) => SiteRulesAnswer | Promise<SiteRulesAnswer>;

export interface HostHandlerOptions {
  source: HostRequestContext["source"];
  /** What this run must stay off. Only a chat's answer may carry `allow`. */
  siteRules?: SiteRulesProvider;
  /** Graft's mapped-site call path, so its browser calls stay attributed to this chat. */
  siteMapper?: (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined;
  /** The fast model page.observe / page.act use. */
  model?: () => Promise<ModelLike | undefined>;
  /** Graft-only requests: workspace files, site skills, saved reads. */
  extra?: (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined;
}

type LiveViews = (request: { liveView: string } & Record<string, unknown>) => Promise<unknown>;
let liveViews: LiveViews | undefined;

/** The daemon's live viewers: `{liveView: 'start'|'stop'|'list'}` from any browser code run. */
export function useLiveViews(handler: LiveViews | undefined): void {
  liveViews = handler;
}

function liveViewRequest(request: unknown): Promise<unknown> | undefined {
  const value = request as ({ liveView?: unknown } & Record<string, unknown>) | null;
  if (typeof value?.liveView !== "string") return undefined;
  if (!liveViews)
    return Promise.reject(new Error("UNSUPPORTED: live viewers run in the Graft daemon"));
  return liveViews(value as { liveView: string } & Record<string, unknown>);
}

/** Where browser.changes() keeps its sets: the daemon's SQLite store. */
export interface ChangeSetsStore {
  get(owner: string, name: string): Array<[string, unknown]> | undefined;
  put(owner: string, name: string, entries: Array<[string, unknown]>): boolean;
}
let changeSets: ChangeSetsStore | undefined;

/** The daemon's store for browser.changes() baselines. */
export function useChangeSets(store: ChangeSetsStore | undefined): void {
  changeSets = store;
}

/**
 * `{changeSets: 'load'|'save', name, entries?}` from browser.changes(), kept for `owner`: a
 * watcher's routine (`routine:<id>`) or a chat (`chat:<id>`). Undefined for any other request.
 */
export function changeSetsRequest(request: unknown, owner: string): Promise<unknown> | undefined {
  const value = request as { changeSets?: unknown; name?: unknown; entries?: unknown } | null;
  if (value?.changeSets !== "load" && value?.changeSets !== "save") return undefined;
  const name = String(value.name ?? "").slice(0, 200);
  if (!changeSets || !name) return Promise.resolve(null);
  if (value.changeSets === "load") {
    const entries = changeSets.get(owner, name);
    return Promise.resolve(entries ? { entries } : null);
  }
  if (!Array.isArray(value.entries))
    return Promise.reject(new Error("INVALID_INPUT: changeSets save needs entries"));
  const entries = (value.entries as unknown[]).filter(
    (entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === "string",
  );
  return Promise.resolve({ saved: changeSets.put(owner, name, entries) });
}

/** The shared handler with Graft's provider; the source goes in the context of every call. */
export function createGraftHostHandler(
  options: HostHandlerOptions,
): (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined {
  const siteRules = options.siteRules;
  const extra = options.extra;
  return createHostHandler({
    ...(siteRules ? { siteRules: (context: HostRequestContext) => siteRules(context.scope) } : {}),
    ...(options.siteMapper ? { siteMapper: options.siteMapper } : {}),
    extra: (request, context) =>
      liveViewRequest(request) ??
      changeSetsRequest(request, `chat:${context.scope}`) ??
      extra?.(request, context),
    ...(options.model ? { model: options.model } : {}),
  });
}
