import { handleCredentialRequest, isCredentialRequest } from "@browserkit/credentials";

// Requests a running cell makes of this machine rather than of the browser: a login from the
// user's password manager, and the sites this run must stay off. Both come from the engine, never
// from agent code, and neither answer is ever written to a trace, a journal or a step list.

export interface SiteRulesAnswer {
  blocked: string[];
  only: string[];
  allow: string[];
}

export type SiteRulesProvider = (chatId: string) => SiteRulesAnswer | Promise<SiteRulesAnswer>;

export function isSiteRulesRequest(value: unknown): boolean {
  return (value as { siteRules?: unknown } | null)?.siteRules === true;
}

export interface HostRequestContext {
  /** Aeon's data folder: password-manager.json lives here. */
  dataDirectory: string;
  siteRules?: SiteRulesProvider;
}

/** The machine's answer to a host request, or undefined when the request is not one of these. */
export function hostRequest(
  chatId: string,
  request: unknown,
  context: HostRequestContext,
): Promise<unknown> | undefined {
  if (isCredentialRequest(request)) return handleCredentialRequest(request, context.dataDirectory);
  if (!isSiteRulesRequest(request)) return undefined;
  return Promise.resolve(context.siteRules?.(chatId)).then((rules) => ({
    blocked: rules?.blocked ?? [],
    only: rules?.only ?? [],
    allow: rules?.allow ?? [],
  }));
}
