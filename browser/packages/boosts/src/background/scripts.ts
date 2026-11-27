import { matchPatternProblem } from "../shared/checks.js";
import { chromePatterns, ruleRegexSource } from "../shared/match.js";
import type { Boost, SiteRule } from "../shared/types.js";
import { GLOBAL_NAMES } from "../runtime/index.js";
import { allBoosts, getSettings, getSites, getValues, log, storeKey } from "./store.js";

// Boosts with JavaScript (and userscripts) run through chrome.userScripts: each one is registered
// with its runtime, @require code, a snapshot of its stored values and an exact URL check.

declare const __GM_RUNTIME__: string;

const PREFIX = "sb-";
const HEADER = /==UserScript==[\s\S]*?==\/UserScript==/;
const WORLD_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'none'";

export async function userScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

const runAt = (boost: Boost): chrome.userScripts.RegisteredUserScript["runAt"] => {
  const value = boost.runAt ?? "document-idle";
  if (value === "document-start" || value === "document-body") return "document_start";
  if (value === "document-end") return "document_end";
  return "document_idle";
};

function scriptInfo(boost: Boost): Record<string, unknown> {
  const meta = { match: [], include: [], exclude: [], grant: [], resource: [], ...boost.meta };
  const injectInto = boost.jsWorld === "page" ? "page" : "content";
  return {
    script: {
      name: boost.name,
      namespace: meta.namespace,
      version: meta.version,
      description: boost.description,
      author: meta.author,
      homepage: meta.homepage,
      icon: meta.icon,
      matches: meta.match,
      includes: meta.include,
      excludes: meta.exclude,
      grant: meta.grant,
      resources: meta.resource.map((r) => ({ name: r.name, url: r.url })),
      "run-at": boost.runAt,
      "inject-into": injectInto,
      tags: boost.tags,
      uuid: boost.id,
    },
    scriptMetaStr: HEADER.exec(boost.source ?? "")?.[0] ?? "",
    scriptHandler: "Site Boosts",
    version: chrome.runtime.getManifest().version,
    injectInto,
    uuid: boost.id,
  };
}

const ruleList = (rules: SiteRule[]): string =>
  `[${rules.map((rule) => `new RegExp(${JSON.stringify(ruleRegexSource(rule))}, "i")`).join(",")}]`;

/** Hosts where it must never run (site switches): checked once, before anything starts. */
function blockedCheck(blocked: SiteRule[]): string {
  return blocked.length
    ? `if (${ruleList(blocked)}.some((r) => r.test(location.href))) return;`
    : "";
}

/**
 * The exact URL check, re-run on every in-page navigation: the registered match patterns only
 * pick the hosts, so a boost for /deep/* starts when a single-page app routes there.
 */
function urlRule(includes: SiteRule[], excludes: SiteRule[]): string {
  return `((__inc, __exc) => (href) => __inc.some((r) => r.test(href)) && !__exc.some((r) => r.test(href)))(${ruleList(includes)}, ${ruleList(excludes)})`;
}

/** Valid match patterns only, widened to the whole host: paths are the runtime's URL check. */
function hostPatterns(rules: SiteRule[]): string[] {
  const patterns = chromePatterns(rules)
    .filter((pattern) => !matchPatternProblem(pattern))
    .map((pattern) =>
      pattern === "<all_urls>" ? pattern : pattern.replace(/^([^:]+:\/\/[^/]+)\/.*$/, "$1/*"),
    );
  return patterns.includes("<all_urls>") ? ["<all_urls>"] : [...new Set(patterns)];
}

const WAIT_FOR_BODY = `if (!document.body) await new Promise((done) => new MutationObserver((_, observer) => { if (document.body) { observer.disconnect(); done(); } }).observe(document.documentElement, { childList: true }));`;

export interface Built {
  main: chrome.userScripts.RegisteredUserScript;
  bridge?: chrome.userScripts.RegisteredUserScript;
}

/** The script's code: the URL check, the runtime, its @require code and its own code. */
function scriptCode(
  boost: Boost,
  values: Record<string, unknown>,
  check: { blocked: string; rule: string },
  nonce: string,
): string {
  const config = {
    id: boost.id,
    nonce,
    world: boost.jsWorld === "page" ? "page" : "isolated",
    grantAll: boost.kind === "boost",
    grants: boost.meta?.grant ?? [],
    values,
    resources: boost.resources ?? {},
    info: scriptInfo(boost),
  };
  const requires = (boost.requires ?? []).map((r) => `${r.code}\n;`).join("\n");
  const body = boost.runAt === "document-body" ? `${WAIT_FOR_BODY}\n` : "";
  // The script's code is a function the runtime calls each time its rules match this URL, and
  // stops (onStop handlers, nodes it added, listeners, timers) when they no longer do.
  return [
    `(() => { ${check.blocked}`,
    __GM_RUNTIME__,
    `const __sb = __sbRuntime.start(${JSON.stringify(config)}, ${check.rule});`,
    `__sb.__run(async function (${GLOBAL_NAMES.join(", ")}) { ${body}`,
    requires,
    `try {\n${boost.js ?? ""}\n} catch (error) { __sb.__report(error); }`,
    `});`,
    `})();`,
  ].join("\n");
}

/** A page-world script reaches its declared @connect hosts, else only its own sites' hosts. */
export function pagePolicy(boost: Boost): { connect: string[]; sites: string[] } {
  const connect = (boost.meta?.connect ?? []).filter((rule) => rule.trim() !== "*");
  if (connect.length) return { connect, sites: [] };
  const hosts = chromePatterns(boost.sites)
    .map((pattern) => /^[^:]+:\/\/(?:\*\.)?([^/*]+)\//.exec(pattern)?.[1])
    .filter((host): host is string => Boolean(host));
  return { connect: [], sites: [...new Set(hosts)] };
}

/** The registrations for one boost. `blocked` are rules where it must not run (site switches). */
export function buildRegistration(
  boost: Boost,
  values: Record<string, unknown>,
  blocked: SiteRule[],
  nonce: string,
): Built {
  // Isolated is the default: page JavaScript cannot reach an isolated script channel.
  const page = boost.jsWorld === "page";
  const rule = urlRule(boost.sites, boost.excludes ?? []);
  const blockedOnly = blockedCheck(blocked);
  const common = {
    matches: hostPatterns(boost.sites),
    runAt: runAt(boost),
    allFrames: boost.allFrames ?? false,
  };
  const worldId = PREFIX + boost.id;
  const main: chrome.userScripts.RegisteredUserScript = {
    id: PREFIX + boost.id,
    ...common,
    js: [{ code: scriptCode(boost, values, { blocked: blockedOnly, rule }, nonce) }],
    ...(page ? { world: "MAIN" } : { world: "USER_SCRIPT", worldId }),
  };
  if (!page) return { main };
  const bridge: chrome.userScripts.RegisteredUserScript = {
    id: `${PREFIX}${boost.id}-bridge`,
    ...common,
    // The bridge must be listening before the script starts.
    runAt: "document_start",
    js: [
      {
        code: `(() => { ${blockedOnly}\n${__GM_RUNTIME__}\n__sbRuntime.bridge(${JSON.stringify(nonce)}, ${JSON.stringify(boost.id)}, ${JSON.stringify(pagePolicy(boost))}); })();`,
      },
    ],
    world: "USER_SCRIPT",
    worldId,
  };
  return { main, bridge };
}

/** Hosts where a boost must not run: the blocklist, sites switched off, and per-site switches. */
async function blockedRules(): Promise<(boost: Boost) => SiteRule[]> {
  const settings = await getSettings();
  const sites = await getSites();
  const global: SiteRule[] = settings.blocklist.map((value) =>
    value.includes("/") || value.includes("*")
      ? { type: "glob", value }
      : { type: "domain", value },
  );
  for (const [host, state] of Object.entries(sites))
    if (state.off) global.push({ type: "domain", value: host });
  return (boost) => [
    ...global,
    ...Object.entries(sites)
      .filter(([, state]) => state.boostsOff?.includes(boost.id))
      .map(([host]): SiteRule => ({ type: "domain", value: host })),
  ];
}

let secret: Promise<string> | undefined;
/** The name of the page/bridge channel: stable for this install, unknown to pages. */
async function nonceFor(id: string): Promise<string> {
  const name = storeKey("secret");
  secret ??= chrome.storage.local.get(name).then(async (stored) => {
    if (typeof stored[name] === "string") return stored[name];
    const created = crypto.randomUUID().replace(/-/g, "");
    await chrome.storage.local.set({ [name]: created });
    return created;
  });
  return (await secret) + id.replace(/\W/g, "");
}

let syncing: Promise<void> = Promise.resolve();

/**
 * Brings the registered scripts in line with the stored boosts. With `only`, just those boosts'
 * scripts are rebuilt (a value change), and nothing else is touched.
 */
export function syncScripts(only?: Set<string>): Promise<void> {
  syncing = syncing.catch(() => undefined).then(() => doSync(only));
  return syncing;
}

async function desiredScripts(
  only?: Set<string>,
): Promise<chrome.userScripts.RegisteredUserScript[]> {
  const settings = await getSettings();
  if (settings.paused) return [];
  const blocked = await blockedRules();
  const out: chrome.userScripts.RegisteredUserScript[] = [];
  for (const boost of await allBoosts()) {
    if (only && !only.has(boost.id)) continue;
    if (!boost.enabled || !boost.js || boost.runAt === "context-menu") continue;
    const built = buildRegistration(
      boost,
      await getValues(boost.id),
      blocked(boost),
      await nonceFor(boost.id),
    );
    // A boost whose every site rule is invalid has nothing Chrome could register.
    if (!built.main.matches?.length) continue;
    if (built.bridge) out.push(built.bridge);
    out.push(built.main);
  }
  return out;
}

const boostIdOf = (scriptId: string): string =>
  scriptId.slice(PREFIX.length).replace(/-bridge$/, "");

async function doSync(only?: Set<string>): Promise<void> {
  if (!(await userScriptsAvailable())) return;
  const desired = await desiredScripts(only);
  const existing = (await chrome.userScripts.getScripts()).filter(
    (s) => s.id.startsWith(PREFIX) && (!only || only.has(boostIdOf(s.id))),
  );
  const wanted = new Map(desired.map((s) => [s.id, s]));
  const stale = existing.filter((s) => !wanted.has(s.id)).map((s) => s.id);
  if (stale.length) await chrome.userScripts.unregister({ ids: stale });
  const current = new Map(existing.map((s) => [s.id, s]));
  const added = desired.filter((s) => !current.has(s.id));
  const changed = desired.filter(
    (s) =>
      current.has(s.id) &&
      JSON.stringify(current.get(s.id)) !== JSON.stringify({ ...current.get(s.id), ...s }),
  );
  for (const script of [...added, ...changed])
    if (script.worldId)
      await chrome.userScripts.configureWorld({
        worldId: script.worldId,
        messaging: true,
        csp: WORLD_CSP,
      });
  try {
    if (added.length) await chrome.userScripts.register(added);
    if (changed.length) await chrome.userScripts.update(changed);
  } catch (error) {
    log({
      level: "error",
      message: `Could not register scripts: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

type Sources = [chrome.userScripts.ScriptSource, ...chrome.userScripts.ScriptSource[]];

/** Runs a script once in a tab now (context-menu scripts, previews). */
export async function runOnce(boost: Boost, tabId: number, frameId = 0): Promise<void> {
  const built = buildRegistration(
    { ...boost, runAt: "document-idle" },
    await getValues(boost.id),
    [],
    await nonceFor(boost.id),
  );
  const target = { tabId, frameIds: [frameId] };
  if (built.bridge) {
    await chrome.userScripts.configureWorld({
      worldId: PREFIX + boost.id,
      messaging: true,
      csp: WORLD_CSP,
    });
    await chrome.userScripts.execute({
      target,
      js: built.bridge.js as Sources,
      world: "USER_SCRIPT",
      worldId: PREFIX + boost.id,
    });
  } else
    await chrome.userScripts.configureWorld({
      worldId: PREFIX + boost.id,
      messaging: true,
      csp: WORLD_CSP,
    });
  await chrome.userScripts.execute({
    target,
    js: built.main.js as Sources,
    world: built.main.world,
    ...(built.main.worldId ? { worldId: built.main.worldId } : {}),
  });
}

/**
 * Throttled re-registration for stored-value changes: at most one 800 ms wait from the first
 * write (later writes never push it back), and only the boosts whose values changed.
 */
let pending: ReturnType<typeof setTimeout> | undefined;
const changedBoosts = new Set<string>();
export const SYNC_WAIT_MS = 800;
export function syncSoon(boostId: string): void {
  changedBoosts.add(boostId);
  pending ??= setTimeout(() => {
    pending = undefined;
    const ids = new Set(changedBoosts);
    changedBoosts.clear();
    void syncScripts(ids);
  }, SYNC_WAIT_MS);
}
