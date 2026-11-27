// One host for running abilities, shared by browser code, the browserkit CLI and Graft's daemon:
// site calls through the mapped runtime, and page scripts, controls and saved steps in the site's
// own tab (the caller's when it is on that origin, never a tab on another origin).

import type { AbilityHost } from "./abilities.js";
import { sharedBridge, type Bridge } from "./runtime/bridge.js";
import type { RecipeHost } from "./runtime/recipe.js";
import { siteActCode, siteControlsCode, siteScriptCode } from "./runtime/site-tab.js";
import { siteHome, siteName } from "./registry.js";

export interface AbilityHostOptions {
  /** An already-open bridge (Graft's daemon, tests); default: the shared one. */
  bridge?: Bridge;
  /** The browser session page work runs in; default: one per site. */
  session?: string;
  /** The tab the caller is on: used when it is on the ability's origin. */
  callerTab?: number;
  /** Where to open a tab when none is on the site; default: the site's home page. */
  url?: string;
}

export function abilityHostFor(site: string, options: AbilityHostOptions = {}): AbilityHost {
  const session = options.session ?? `ability-${siteName(site)}`;
  const home = options.url ?? siteHome(siteName(site));
  const bridge = once(async () => options.bridge ?? (await sharedBridge()));
  const recipe = once(async () => {
    const { browserRecipeHost } = await import("./runtime/recipe-host.js");
    return browserRecipeHost(site, {
      session,
      ...(options.bridge ? { bridge: options.bridge } : {}),
    });
  });
  const run = async (code: string): Promise<unknown> =>
    (await bridge()).run(code, { session, timeoutMs: 120_000 });
  let resolve: RecipeHost["resolveOperation"];
  void recipe().then(
    (host) => (resolve = host.resolveOperation),
    () => undefined,
  );
  return {
    // With no bridge of its own, site calls take the in-process request path, as they always did.
    call: async (operation, params) =>
      options.bridge
        ? (await recipe()).call(operation, params)
        : handleCall(site, operation, params),
    write: async (operation, params) => {
      if (!options.bridge) return handleCall(site, operation, params);
      const host = await recipe();
      return (host.write ?? host.call)(operation, params);
    },
    resolveOperation: (wanted) => resolve?.(wanted),
    open: async (url) => required(await recipe(), "open")(url),
    collect: async (input) => required(await recipe(), "collect")(input),
    script: async (code, inputs) =>
      scriptAnswer(await run(siteScriptCode(home, code, inputs, options.callerTab))),
    controls: async () =>
      (await run(siteControlsCode(home, options.callerTab))) as {
        role?: string;
        name?: string;
        text?: string;
      }[],
    act: async (step) => run(siteActCode(home, step, options.callerTab)),
  };
}

/** A script's answer, or its error rethrown with whether it ever touched the page. */
function scriptAnswer(value: unknown): unknown {
  const failed = value as { __abilityScriptError?: unknown; touched?: unknown } | null;
  if (!failed || typeof failed !== "object" || typeof failed.__abilityScriptError !== "string")
    return value;
  const message = failed.__abilityScriptError;
  const error = new Error(/^[A-Z_]+:/.test(message) ? message : `CODE_ERROR: ${message}`);
  if (failed.touched === false) (error as Error & { pageUntouched?: boolean }).pageUntouched = true;
  throw error;
}

/** The shared host on its own bridge: what a run gets when its caller passes none. */
export function defaultHost(site: string): AbilityHost {
  return abilityHostFor(site);
}

/** The default host with every write refused: for background checks that must never change a site. */
export function readOnlyHost(site: string): AbilityHost {
  const host = defaultHost(site);
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("ABILITY_READ_ONLY: a background check never writes"));
  return { ...host, write: refuse };
}

export async function handleCall(
  site: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { handleSiteMapperRequest } = await import("./requests.js");
  return handleSiteMapperRequest({ siteMapper: "call", site, operation, params });
}

function required<K extends "open" | "collect">(
  host: RecipeHost,
  name: K,
): NonNullable<RecipeHost[K]> {
  const run = host[name];
  if (!run) throw new Error(`ABILITY_NEEDS: the browser host has no ${name}`);
  return run as NonNullable<RecipeHost[K]>;
}

function once<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
}
