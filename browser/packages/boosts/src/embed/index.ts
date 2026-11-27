import { useHostSiteMapper } from "../background/integrations.js";
import { normalizeBoost } from "../shared/bundle.js";
import { errorText, type Reply } from "../shared/messages.js";
import { boostMatches } from "../shared/match.js";
import type { Boost, HealthReport } from "../shared/types.js";
import { setRuleRange, syncNetwork } from "../background/dnr.js";
import { listenToScripts, scriptTabs, stopScripts } from "../background/gm.js";
import { recordHealth } from "../background/health.js";
import { forgetView, rememberView } from "../background/live.js";
import { runOnce, syncScripts } from "../background/scripts.js";
import { cspWarning, selectorWarnings, siteRuleWarnings, type Warning } from "../shared/checks.js";
import { planFor } from "../background/sites.js";
import {
  allBoosts,
  deleteBoost,
  getBoost,
  getCsp,
  getHealth,
  noteCsp,
  patchBoost,
  putBoost,
  setStorePrefix,
} from "../background/store.js";

// The boost engine inside another extension's service worker: saved boosts (styles, hidden
// elements, actions, network rules, scripts) apply in every tab, without Site Boosts installed.
// Its storage keys, network rule ids, script ids and messages are namespaced, so it never meets
// the host's own. Authoring, repairs, the toolbar UI and userscript installs stay in Site Boosts.

export const MESSAGE_PREFIX = "boosts.";
const CONTENT_SCRIPT_ID = "sb-content";
const PAGE_PARTS = ["css", "sections", "zaps", "look", "actions", "html", "widgets"] as const;

export interface BoostEngineOptions {
  /** The content script the host built with site-boosts/embed-build (writeContent). */
  contentScript: string;
  /**
   * Answers boosts' site API calls (sb.api) itself, e.g. through the host's own site-to-api.
   * Without it they go to a site-to-api server set in the settings, or to a companion extension.
   */
  siteMapper?: (
    site: string,
    operation: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface BoostRunState {
  /** When the script last started, and on which page. */
  lastRun: { at: number; url: string } | null;
  /** Its last uncaught error. */
  lastError: { message: string; stack?: string; at: number; url: string } | null;
  /** Tabs it is running in now. */
  tabs: number[];
  /** ok, broken (selectors stopped matching) or unknown. */
  health: string;
}

export interface BoostSummary extends BoostRunState {
  id: string;
  name: string;
  enabled: boolean;
  sites: Boost["sites"];
  parts: string[];
  updated: number;
}

export interface SavedBoost extends BoostSummary {
  /** What looks wrong at save time; the boost is saved either way. */
  warnings: Warning[];
}

export interface BoostEngine {
  list(url?: string): Promise<BoostSummary[]>;
  get(id: string): Promise<(Boost & BoostRunState) | undefined>;
  /** Saves a boost (new without an id, replaced with one) and applies it in open tabs. */
  save(input: Record<string, unknown>): Promise<SavedBoost>;
  /** Live viewers boosts may push to (GM.liveView.push); their tokens stay in the worker. */
  rememberView(view: Record<string, unknown>): Promise<{ id: string }>;
  forgetView(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** The wire rules of the boosts active on this URL, as saved. */
  wireFor(url: string): Promise<unknown[]>;
}

const partsOf = (boost: Boost): string[] =>
  [...PAGE_PARTS, "js", "network", "wire"].filter((part) => {
    const value = (boost as unknown as Record<string, unknown>)[part];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

async function runState(boost: Boost): Promise<BoostRunState> {
  const health = await getHealth(boost.id);
  return {
    lastRun: health.lastRun ?? null,
    lastError: health.lastError ?? null,
    tabs: scriptTabs(boost.id),
    health: health.status,
  };
}

const summary = async (boost: Boost): Promise<BoostSummary> => ({
  id: boost.id,
  name: boost.name,
  enabled: boost.enabled,
  sites: boost.sites,
  parts: partsOf(boost),
  updated: boost.updated,
  ...(await runState(boost)),
});

/** Page-world scripts on hosts that enforced a strict CSP on their last load. */
async function cspWarnings(boost: Boost): Promise<Warning[]> {
  if (!boost.js || boost.jsWorld !== "page") return [];
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  const hosts = new Set<string>();
  for (const tab of tabs)
    if (tab.url && boostMatches(boost, tab.url)) hosts.add(new URL(tab.url).hostname);
  for (const rule of boost.sites)
    if (rule.type === "domain") hosts.add(rule.value).add(`www.${rule.value}`);
    else if (rule.value && /^[a-z]+:\/\/[^/*]+/i.test(rule.value))
      hosts.add(new URL(rule.value.replace(/\*/g, "x")).hostname);
  const warnings: Warning[] = [];
  for (const host of hosts) {
    const note = await getCsp(host);
    if (note) warnings.push(cspWarning(host, note.directive));
  }
  return warnings.slice(0, 3);
}

async function saveWarnings(boost: Boost): Promise<Warning[]> {
  return [...siteRuleWarnings(boost), ...selectorWarnings(boost), ...(await cspWarnings(boost))];
}

/** A boost switched back on runs in its open tabs at once, as a fresh start. */
async function startInOpenTabs(boost: Boost): Promise<void> {
  if (!boost.js || boost.runAt === "context-menu") return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && tab.url && boostMatches(boost, tab.url))
      .map((tab) => runOnce(boost, tab.id as number)),
  );
}

const hasPagePart = (boost: Boost): boolean =>
  PAGE_PARTS.some((part) => {
    const value = (boost as unknown as Record<string, unknown>)[part];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

/** The content script only runs while some boost changes pages. */
async function syncContentScript(file: string): Promise<void> {
  const wanted = (await allBoosts()).some((b) => b.enabled && hasPagePart(b));
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  });
  if (wanted && !registered.length)
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: [file],
        matches: ["http://*/*", "https://*/*"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  if (!wanted && registered.length)
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
}

async function refreshTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(
    tabs.map((t) =>
      chrome.tabs.sendMessage(t.id as number, { kind: `${MESSAGE_PREFIX}plan.refresh` }),
    ),
  );
}

type Handler = (message: Record<string, unknown>, sender: chrome.runtime.MessageSender) => unknown;

function frameTarget(sender: chrome.runtime.MessageSender): chrome.scripting.InjectionTarget {
  if (sender.tab?.id === undefined) throw new Error("No tab");
  return { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
}

const contentHandlers: Record<string, Handler> = {
  "page.plan": (m) => planFor(String(m.url), m.top !== false),
  "page.csp": async (m, sender) => {
    const url = sender.url ?? sender.tab?.url;
    if (url) await noteCsp(new URL(url).hostname, String(m.directive ?? "").slice(0, 200));
  },
  "page.health": async (m, sender) => {
    for (const { boostId, report } of (m.reports as { boostId: string; report: HealthReport }[]) ??
      [])
      await recordHealth(boostId, report, sender.tab?.id);
  },
  "css.insert": (m, sender) =>
    chrome.scripting.insertCSS({ target: frameTarget(sender), css: String(m.css), origin: "USER" }),
  "css.remove": (m, sender) =>
    chrome.scripting.removeCSS({ target: frameTarget(sender), css: String(m.css), origin: "USER" }),
};

export function startBoostEngine(options: BoostEngineOptions): BoostEngine {
  setStorePrefix("boosts:");
  setRuleRange(500_000, 599_999);

  let chain: Promise<void> = Promise.resolve();
  const changed = (): Promise<void> => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        await Promise.allSettled([
          syncScripts(),
          syncNetwork(),
          syncContentScript(options.contentScript),
        ]);
        await refreshTabs();
      });
    return chain;
  };

  listenToScripts();
  if (options.siteMapper) useHostSiteMapper(options.siteMapper);
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, reply) => {
    const kind = typeof message?.kind === "string" ? message.kind : "";
    if (!kind.startsWith(MESSAGE_PREFIX) || sender.id !== chrome.runtime.id || !sender.tab)
      return false;
    const handler = contentHandlers[kind.slice(MESSAGE_PREFIX.length)];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (value) => reply({ ok: true, value: value ?? null } satisfies Reply),
        (error: unknown) => reply({ ok: false, error: errorText(error) } satisfies Reply),
      );
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => void changed());
  chrome.runtime.onStartup.addListener(() => void changed());

  return {
    async list(url) {
      const boosts = await allBoosts();
      return Promise.all((url ? boosts.filter((b) => boostMatches(b, url)) : boosts).map(summary));
    },
    async get(id) {
      const boost = await getBoost(id);
      return boost ? { ...boost, ...(await runState(boost)) } : undefined;
    },
    rememberView,
    forgetView,
    async save(input) {
      const existing = typeof input.id === "string" ? await getBoost(input.id) : undefined;
      const boost = normalizeBoost({
        ...input,
        created: existing?.created,
        order: existing?.order ?? (await allBoosts()).length,
      });
      const saved = await putBoost(boost, "companion", existing ? "Changed" : "Created");
      await changed();
      return { ...(await summary(saved)), warnings: await saveWarnings(saved) };
    },
    async remove(id) {
      await deleteBoost(id);
      // Running copies take back what they added: widgets, listeners, timers, sockets.
      stopScripts(id);
      await changed();
    },
    async wireFor(url) {
      const plan = await planFor(url);
      if (plan.siteDisabled || plan.paused) return [];
      return plan.boosts.filter((b) => plan.active.includes(b.id)).flatMap((b) => b.wire ?? []);
    },
    async setEnabled(id, enabled) {
      const boost = await patchBoost(id, { enabled });
      if (!boost) throw new Error(`No boost ${id}`);
      if (!enabled) stopScripts(id);
      await changed();
      if (enabled) await startInOpenTabs(boost).catch(() => undefined);
    },
  };
}
