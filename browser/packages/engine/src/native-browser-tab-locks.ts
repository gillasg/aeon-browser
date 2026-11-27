// Hard locks a tab gets when it is opened (openTab {readOnly, allowedOrigins}). A read-only tab
// is read and navigated, never clicked, typed in, pasted into or uploaded to: every such step
// fails with TAB_READ_ONLY. A tab with allowed origins only loads pages on those origins: a
// navigate step elsewhere fails with TAB_ORIGIN_BLOCKED, and session network rules block the
// tab's own top-level loads (links, redirects, scripts that set location) to any other origin.
// The locks last as long as the tab and survive the service worker sleeping.
import type { BrowserStep } from "@browserkit/protocol";
import { onEngineInstall } from "./native-engine-install.js";

export interface TabLocks {
  readOnly?: boolean;
  allowedOrigins?: string[];
}

const STORAGE_KEY = "browserkit-tab-locks";
const RULE_BASE = 799_000;
const RULE_SPAN = 1_000;
const locks = new Map<number, TabLocks & { ruleIds: number[] }>();
let sequence = 0;
let restored: Promise<void> | undefined;

const READ_ONLY_OPS = new Set([
  "click",
  "hold",
  "fill",
  "paste",
  "press",
  "pointer",
  "keys",
  "upload",
]);
const WRITE_CDP =
  /^(Input\.|DOM\.(set|remove|focus)|Page\.(handleJavaScriptDialog|setInterceptFileChooser))/;

/** Origins as "scheme://host[:port]"; anything that is not an http(s) URL is dropped. */
export function normalOrigins(origins: readonly string[]): string[] {
  const out = new Set<string>();
  for (const origin of origins) {
    const url = URL.canParse(origin) ? new URL(origin) : undefined;
    if (url && (url.protocol === "http:" || url.protocol === "https:")) out.add(url.origin);
  }
  return [...out];
}

export function originAllowed(url: string, origins: readonly string[] | undefined): boolean {
  if (!origins?.length) return true;
  if (url === "about:blank") return true;
  return URL.canParse(url) && origins.includes(new URL(url).origin);
}

/** Why a step may not run on a tab with these locks, or undefined when it may. */
export function lockedStep(step: BrowserStep, tabLocks: TabLocks | undefined): string | undefined {
  if (!tabLocks) return undefined;
  if (tabLocks.readOnly && writesPage(step))
    return `TAB_READ_ONLY: tab is read-only, so ${step.op} is blocked; read it or open another tab to act`;
  if (step.op === "navigate" && !originAllowed(step.url, tabLocks.allowedOrigins))
    return `TAB_ORIGIN_BLOCKED: this tab may only visit ${tabLocks.allowedOrigins?.join(", ")}, not ${step.url}`;
  return undefined;
}

function writesPage(step: BrowserStep): boolean {
  if (READ_ONLY_OPS.has(step.op)) return true;
  if (step.op === "frames") return ["click", "fill", "cdp"].includes(step.action);
  if (step.op === "dialog") return true;
  if (step.op === "cdp") return WRITE_CDP.test(step.method);
  return false;
}

/** Session rules: block the tab's top-level loads, then allow each listed origin above that. */
export function originRules(
  tabId: number,
  origins: readonly string[],
): chrome.declarativeNetRequest.Rule[] {
  const next = () => RULE_BASE + (sequence++ % RULE_SPAN);
  const condition = {
    tabIds: [tabId],
    resourceTypes: ["main_frame"] as chrome.declarativeNetRequest.ResourceType[],
  };
  return [
    {
      id: next(),
      priority: 8,
      action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
      condition,
    },
    ...origins.map((origin) => ({
      id: next(),
      priority: 9,
      action: { type: "allow" as chrome.declarativeNetRequest.RuleActionType },
      condition: { ...condition, urlFilter: `|${origin}/` },
    })),
  ];
}

export async function setTabLocks(tabId: number, wanted: TabLocks): Promise<void> {
  await restore();
  const origins = wanted.allowedOrigins ? normalOrigins(wanted.allowedOrigins) : undefined;
  if (wanted.allowedOrigins && !origins?.length)
    throw new Error("INVALID_INPUT: allowedOrigins needs at least one http(s) origin");
  if (!wanted.readOnly && !origins) return;
  const rules = origins ? originRules(tabId, origins) : [];
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  locks.set(tabId, {
    ...(wanted.readOnly ? { readOnly: true } : {}),
    ...(origins ? { allowedOrigins: origins } : {}),
    ruleIds: rules.map((rule) => rule.id),
  });
  await save();
}

export async function tabLocks(tabId: number): Promise<TabLocks | undefined> {
  await restore();
  return locks.get(tabId);
}

/** Throws the step's lock error, if the tab has a lock that forbids it. */
export async function assertTabLocks(tabId: number, step: BrowserStep): Promise<void> {
  const reason = lockedStep(step, await tabLocks(tabId));
  if (reason) throw new Error(reason);
}

async function release(tabId: number): Promise<void> {
  await restore();
  const record = locks.get(tabId);
  if (!record) return;
  locks.delete(tabId);
  if (record.ruleIds.length)
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: record.ruleIds })
      .catch(() => undefined);
  await save();
}

function restore(): Promise<void> {
  restored ??= (async () => {
    const stored = (await chrome.storage?.session?.get(STORAGE_KEY).catch(() => ({}))) as
      Record<string, unknown> | undefined;
    const entries = stored?.[STORAGE_KEY];
    if (!Array.isArray(entries)) return;
    for (const [tabId, record] of entries as [number, TabLocks & { ruleIds: number[] }][])
      if (!locks.has(tabId)) locks.set(tabId, record);
    sequence = Math.max(
      sequence,
      ...[...locks.values()].flatMap((r) => r.ruleIds.map((id) => id - RULE_BASE + 1)),
    );
  })();
  return restored;
}

async function save(): Promise<void> {
  await chrome.storage?.session?.set({ [STORAGE_KEY]: [...locks] }).catch(() => undefined);
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => void release(tabId));
});
