import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { send } from "./cdp/send.js";
import { readSegment } from "@browserkit/site-mapper/request-words";

// Dry run: while a tab records with {dryRun: true}, requests that would change something (a like,
// a message, a post, a purchase) are answered by the browser itself with an empty success and never
// reach the site. The recorder still sees them, request and all, so the action can be mapped
// without doing it. Reads (GET, searches, GraphQL queries) go through untouched.
const dryRunTabs = new Set<number>();
export const DRY_RUN_HEADER = "x-dry-run";
type Params = Record<string, unknown>;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Default to write. A GET/HEAD is a read only when its path does not change state; a GraphQL
// query is a read. Anything uncertain is blocked in a dry run: a missed read leaves a gap in
// the map, a passed write really happens.
const STATE_CHANGING_PATH =
  /(^|\/)(logout|signout|sign-out|unsubscribe|delete|remove|destroy|archive|block|mute|like|unlike|follow|unfollow|vote|report|send|submit|create|update|edit|save|add|checkout|order|buy|pay|purchase|book|reserve|cancel|refund|invite|accept|reject|approve|join|leave|upload|post|comment|reply|message|share|subscribe)(\/|$)/i;

// A POST whose last path segment names a read (Bandcamp's /api/discover/1/discover_web, a
// search or list endpoint) is a read too, but only when no segment changes state and the body
// holds only filter/paging keys: no write verb, no unknown field.
const WRITE_BODY =
  /\b(mutation|delete|remove|create|update|insert|add|send|submit|purchase|checkout|pay)\b/i;
const FILTER_KEY =
  /^(q|query|term|search|keywords?|filters?|facets?|tags?|tag_norm_names|category(_id)?|genre(_id)?|slice|sort|order_by|sort_by|cursor|after|before|page|page_size|per_page|size|limit|offset|count|from|start|geoname_id|location|lang|locale|include_result_types|format)$/i;

function readOnlyPost(url: string, body?: string): boolean {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return false;
  }
  const last = segments.at(-1) ?? "";
  if (!readSegment(last) || STATE_CHANGING_PATH.test(`/${segments.join("/")}`)) return false;
  if (!body) return true;
  if (WRITE_BODY.test(body)) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.keys(parsed).every((key) => FILTER_KEY.test(key));
  } catch {
    return false;
  }
}

/** True when a request only reads: reads go through even during a dry run. */
export function looksLikeRead(method: string, url: string, body?: string): boolean {
  if (body && /\bmutation\b/.test(body)) return false;
  if (body && /"query"\s*:\s*"\s*(query\b|\{)/.test(body)) return true;
  if (body && /"query"\s*:/.test(body)) return false;
  if (method.toUpperCase() === "POST") return readOnlyPost(url, body);
  if (!READ_METHODS.has(method.toUpperCase())) return false;
  try {
    return !STATE_CHANGING_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    const tabId = source.tabId;
    if (method !== "Fetch.requestPaused" || tabId === undefined || !dryRunTabs.has(tabId)) return;
    void answer(tabId, source.sessionId, (raw ?? {}) as Params);
  });
});

async function answer(tabId: number, sessionId: string | undefined, params: Params): Promise<void> {
  const request = (params.request ?? {}) as Params;
  const requestId = String(params.requestId);
  const debuggee = sessionId ? { tabId, sessionId } : { tabId };
  const read = looksLikeRead(
    String(request.method ?? "GET"),
    String(request.url ?? ""),
    typeof request.postData === "string" ? request.postData : undefined,
  );
  const deliver = (command: string, body: Params) =>
    send(debuggee, command, body, { label: "answer" }).catch(() => undefined);
  if (read) return void (await deliver("Fetch.continueRequest", { requestId }));
  await deliver("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: "content-type", value: "application/json" },
      { name: DRY_RUN_HEADER, value: "blocked" },
    ],
    body: btoa("{}"),
  });
}

const PATTERNS = ["XHR", "Fetch", "Document", "Ping", "Other"].map((resourceType) => ({
  urlPattern: "*",
  resourceType,
  requestStage: "Request",
}));

export async function setDryRun(tabId: number, enabled: boolean): Promise<void> {
  if (enabled === dryRunTabs.has(tabId)) return;
  if (enabled) dryRunTabs.add(tabId);
  else dryRunTabs.delete(tabId);
  await withBrowserDebugger(tabId, (debuggee) =>
    send(
      debuggee,
      enabled ? "Fetch.enable" : "Fetch.disable",
      enabled ? { patterns: PATTERNS } : {},
      { label: "setDryRun" },
    ),
  ).catch(() => undefined);
}

export const dryRunActive = (tabId: number): boolean => dryRunTabs.has(tabId);

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => dryRunTabs.delete(tabId));
});
