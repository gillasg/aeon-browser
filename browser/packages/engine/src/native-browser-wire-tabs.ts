import { send } from "./cdp/send.js";
import { dryRunActive } from "./native-browser-dry-run.js";
import { onBrowserDebuggerAttached, withBrowserDebugger } from "./native-browser-session.js";
import {
  fetchPatterns,
  isSignInUrl,
  matchingRules,
  rewriteResponse,
  sanitizeWireRule,
  type WireHeader,
  type WireRule,
} from "./native-browser-wire.js";

// Wire rules on live tabs. A tab gets DevTools Fetch only while its URL's host has an active wire
// rule; every other tab is never attached, paused or read. Saving, switching off or removing a
// boost re-syncs open tabs, so an undo takes the interception away at once. Tabs in a dry run and
// sign-in pages are left alone. Nothing here logs a header, cookie or body.

type Params = Record<string, unknown>;
export type WireSource = (url: string) => Promise<unknown[]>;

const active = new Map<number, { key: string; rules: WireRule[] }>();
let source: WireSource | undefined;

export const wireTabs = (): number[] => [...active.keys()];
export const wireRulesOn = (tabId: number): WireRule[] => active.get(tabId)?.rules ?? [];

async function rulesFor(url: string): Promise<WireRule[]> {
  if (!source || !/^https?:/i.test(url) || isSignInUrl(url)) return [];
  const raw = await source(url).catch(() => []);
  return raw.map(sanitizeWireRule).filter((rule): rule is WireRule => Boolean(rule));
}

async function enable(tabId: number, rules: WireRule[]): Promise<void> {
  await withBrowserDebugger(tabId, (debuggee) =>
    send(debuggee, "Fetch.enable", { patterns: fetchPatterns(rules) }, { label: "wire" }),
  );
}

async function disable(tabId: number): Promise<void> {
  active.delete(tabId);
  if (dryRunActive(tabId)) return;
  await withBrowserDebugger(tabId, (debuggee) =>
    send(debuggee, "Fetch.disable", {}, { label: "wire" }),
  ).catch(() => undefined);
}

/** Makes one tab's interception match its URL: on with the host's rules, off without any. */
export async function syncWireTab(tabId: number, url: string): Promise<void> {
  const rules = dryRunActive(tabId) ? [] : await rulesFor(url);
  if (!rules.length) {
    if (active.has(tabId)) await disable(tabId);
    return;
  }
  const key = JSON.stringify(rules);
  if (active.get(tabId)?.key === key) return;
  active.set(tabId, { key, rules });
  await enable(tabId, rules).catch(() => active.delete(tabId));
}

export async function syncAllWireTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(
    tabs.map((tab) => (tab.id === undefined ? undefined : syncWireTab(tab.id, tab.url ?? ""))),
  );
  for (const tabId of active.keys())
    if (!tabs.some((tab) => tab.id === tabId)) active.delete(tabId);
}

const toHeaders = (raw: unknown): WireHeader[] =>
  Array.isArray(raw)
    ? raw.map((h: Params) => ({ name: String(h.name), value: String(h.value ?? "") }))
    : [];

function decode(body: string, base64: boolean): string {
  if (!base64) return body;
  return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
}

function encode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decides one paused request: fail a block, rewrite a matching response, or let it go on. */
export async function handlePaused(
  debuggee: chrome.debugger.Debuggee,
  rules: WireRule[],
  params: Params,
): Promise<string> {
  const request = (params.request ?? {}) as Params;
  const requestId = String(params.requestId);
  const call = (method: string, body: Params) =>
    send(debuggee, method, { requestId, ...body }, { label: "wire" }).catch(() => undefined);
  const matched = matchingRules(rules, String(request.url ?? ""), String(request.method ?? "GET"));
  const atResponse = params.responseStatusCode !== undefined || params.responseErrorReason;
  if (!atResponse && matched.some((rule) => rule.action === "block")) {
    await call("Fetch.failRequest", { errorReason: "BlockedByClient" });
    return "blocked";
  }
  const edits = matched.filter((rule) => rule.action !== "block");
  if (!atResponse || !edits.length || params.responseErrorReason) {
    await call(atResponse ? "Fetch.continueResponse" : "Fetch.continueRequest", {});
    return "continued";
  }
  return rewritePaused(debuggee, edits, params, call);
}

async function rewritePaused(
  debuggee: chrome.debugger.Debuggee,
  rules: WireRule[],
  params: Params,
  call: (method: string, body: Params) => Promise<unknown>,
): Promise<string> {
  const requestId = String(params.requestId);
  const got = (await send(
    debuggee,
    "Fetch.getResponseBody",
    { requestId },
    { label: "wire" },
  ).catch(() => undefined)) as { body?: string; base64Encoded?: boolean } | undefined;
  const headers = toHeaders(params.responseHeaders);
  const changed = got?.body
    ? rewriteResponse(rules, { headers, body: decode(got.body, Boolean(got.base64Encoded)) })
    : undefined;
  if (!changed) {
    await call("Fetch.continueResponse", {});
    return "continued";
  }
  await call("Fetch.fulfillRequest", {
    responseCode: Number(params.responseStatusCode ?? 200),
    responseHeaders: changed.headers,
    body: encode(changed.body),
  });
  return "rewritten";
}

let installed = false;

/** Starts wire rules: source gives the active rules' raw data for a URL. */
export function installWire(rules: WireSource): void {
  source = rules;
  if (installed || typeof chrome === "undefined" || !chrome.debugger) return;
  installed = true;
  chrome.debugger.onEvent.addListener((from, method, raw) => {
    const tabId = from.tabId;
    if (method !== "Fetch.requestPaused" || tabId === undefined || dryRunActive(tabId)) return;
    const entry = active.get(tabId);
    if (!entry) return;
    const debuggee = from.sessionId ? { tabId, sessionId: from.sessionId } : { tabId };
    void handlePaused(debuggee, entry.rules, (raw ?? {}) as Params);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === "loading") void syncWireTab(tabId, tab.url ?? "");
  });
  chrome.tabs.onRemoved.addListener((tabId) => active.delete(tabId));
  // A new attachment starts without Fetch: put the tab's rules back.
  onBrowserDebuggerAttached(async (tabId) => {
    const entry = active.get(tabId);
    if (entry) await enable(tabId, entry.rules).catch(() => undefined);
  });
}
