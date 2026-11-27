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

/** The shared handler with Graft's provider; the source goes in the context of every call. */
export function createGraftHostHandler(
  options: HostHandlerOptions,
): (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined {
  const siteRules = options.siteRules;
  const extra = options.extra;
  return createHostHandler({
    ...(siteRules ? { siteRules: (context: HostRequestContext) => siteRules(context.scope) } : {}),
    ...(options.siteMapper ? { siteMapper: options.siteMapper } : {}),
    extra: (request, context) => liveViewRequest(request) ?? extra?.(request, context),
    ...(options.model ? { model: options.model } : {}),
  });
}
