// The node runtime of a script way, run on an isolated worker (script-sandbox.ts). Its `browser.fetch` answers in the same shape as browser
// code's (status, ok, url, headers, then json, text or base64), so an ability written in a cell
// runs unchanged here. One difference stays: node has no browser session, so no cookies are sent;
// a signed-in call belongs in an api way (the site's session) or a page script.

import { hopRefusal, reachOf } from "./runtime/net-guard.js";
import { runSandboxed } from "./script-sandbox.js";

const TIMEOUT_MS = 30_000;
const MAX_TEXT = 2_000_000;

interface NodeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  as?: "auto" | "text" | "base64";
  asOrigin?: boolean;
  timeoutMs?: number;
}

function requestHeaders(url: string, init: NodeFetchInit): Record<string, string> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.asOrigin) {
    const origin = new URL(url).origin;
    headers.referer ??= origin + "/";
    headers.origin ??= origin;
  }
  if (init.json !== undefined) headers["content-type"] ??= "application/json";
  return headers;
}

async function body(response: Response, as: NodeFetchInit["as"]): Promise<Record<string, unknown>> {
  if (as === "base64")
    return { base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
  const text = await response.text();
  if (as !== "text") {
    try {
      return { json: JSON.parse(text) as unknown };
    } catch {
      // Not JSON: return the text.
    }
  }
  return text.length > MAX_TEXT
    ? { text: text.slice(0, MAX_TEXT), truncated: true, length: text.length }
    : { text };
}

const MAX_HOPS = 5;
const DROP_HEADERS = ["cookie", "authorization", "proxy-authorization"];

/** A pack script's fetch stays on its own site: the same host, or a subdomain of it. */
export function onSite(url: URL, site: string): boolean {
  const home = site.toLowerCase().replace(/^www\./, "");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host === home || url.host.toLowerCase() === home || host.endsWith("." + home);
}

async function assertPinned(url: URL, site: string): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`SITE_PINNED: ${url.protocol} is not an http address`);
  if (!onSite(url, site)) throw new Error(`SITE_PINNED: ${url.host} is not ${site}`);
  const refused = await hopRefusal(url.href, reachOf(`https://${site}/`));
  if (refused) throw new Error(`PRIVATE_NETWORK: ${refused}`);
}

/**
 * browser.fetch for pack scripts, in browser code's result shape. Every hop is pinned to the
 * script's site and checked against the private network before it is sent; no cookie is sent.
 */
export async function nodeFetch(
  site: string,
  url: string,
  init: NodeFetchInit = {},
): Promise<unknown> {
  let target = new URL(String(url));
  const headers = new Headers(requestHeaders(target.href, init));
  headers.delete("cookie");
  const hop: Hop = {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
  const signal = AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS);
  for (let count = 0; count <= MAX_HOPS; count++) {
    await assertPinned(target, site);
    const response = await fetch(target, { ...hop, redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location)
      return {
        status: response.status,
        ok: response.ok,
        url: target.href,
        headers: Object.fromEntries(response.headers),
        ...(await body(response, init.as)),
      };
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, target);
    redirectHop(hop, response.status, next.origin !== target.origin);
    target = next;
  }
  throw new Error(`SITE_PINNED: more than ${MAX_HOPS} redirects`);
}

interface Hop {
  method: string;
  headers: Headers;
  body?: string;
}

/** 303 (and 301/302 after a POST) become a bodiless GET; another origin gets no credentials. */
function redirectHop(hop: Hop, status: number, crossOrigin: boolean): void {
  if (crossOrigin) for (const name of DROP_HEADERS) hop.headers.delete(name);
  if (status === 303 || (status <= 302 && hop.method.toUpperCase() === "POST")) {
    hop.method = "GET";
    delete hop.body;
    hop.headers.delete("content-type");
  }
}

export function runNodeScript(
  code: string,
  inputs: Record<string, unknown>,
  call: (operation: string, params: Record<string, unknown>) => Promise<unknown>,
  site: string,
): Promise<unknown> {
  const bridge = (operation: unknown, params: unknown) =>
    call(String(operation), (params ?? {}) as Record<string, unknown>);
  return runSandboxed({
    code,
    inputs,
    filename: "ability.js",
    bridges: {
      call: bridge,
      write: bridge,
      fetch: (url, init) => nodeFetch(site, String(url), (init ?? {}) as NodeFetchInit),
    },
    timeoutMs: TIMEOUT_MS,
    timeoutMessage: "ABILITY_TIMEOUT: node script exceeded 30s",
  });
}
