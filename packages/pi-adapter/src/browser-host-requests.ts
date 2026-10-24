import {
  createHostHandler,
  type HostRequestContext,
  type HostSiteRules,
} from "@browserkit/tools/host";

// Aeon's side of the one host handler: credentials, site rules and mapped-site calls are
// browserkit's; Aeon adds only its own storage (workspace, site skills, saved reads) through
// `extra`. `source` decides whether a typed-user `allow` may lift a block; routines, checks and
// outside sessions always get `allow: []`.

export type { HostRequestContext };

export type SiteRulesAnswer = HostSiteRules;

export type SiteRulesProvider = (scope: string) => SiteRulesAnswer | Promise<SiteRulesAnswer>;

export interface HostHandlerOptions {
  source: HostRequestContext["source"];
  /** What this run must stay off. Only a chat's answer may carry `allow`. */
  siteRules?: SiteRulesProvider;
  /** Aeon's mapped-site call path, so its browser calls stay attributed to this chat. */
  siteMapper?: (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined;
  /** Aeon-only requests: workspace files, site skills, saved reads. */
  extra?: (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined;
}

/** The shared handler with Aeon's provider; the source goes in the context of every call. */
export function createAeonHostHandler(
  options: HostHandlerOptions,
): (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined {
  const siteRules = options.siteRules;
  return createHostHandler({
    ...(siteRules ? { siteRules: (context: HostRequestContext) => siteRules(context.scope) } : {}),
    ...(options.siteMapper ? { siteMapper: options.siteMapper } : {}),
    ...(options.extra ? { extra: options.extra } : {}),
  });
}
