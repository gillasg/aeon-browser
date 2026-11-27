// A mapped-site API call made from the site's own tab (site-mapper's page transport). The engine
// owns the whole call: the caller sends the request, never code. Sealed handles are released for
// the request's own site only, the sign-in headers the site itself sent lately are merged here,
// and the page's own fetch or XMLHttpRequest makes the call, so the site sees the user's browser.
// Nothing raw ever passes back through cell code: the answer is sealed by the host (serveCall).
import { COOKIE_XSRF_HEADERS } from "@browserkit/site-mapper/session-headers";
import { send } from "./cdp/send.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { siteOf, type SealVault } from "./native-browser-seal.js";

export interface PageCall {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    pageHeaders?: string[];
  };
  auth: unknown[];
  via: "fetch" | "xhr";
  crossSite: boolean;
}

const KEYS = new Set(["target", "request", "auth", "via", "crossSite"]);
const REQUEST_KEYS = new Set(["url", "method", "headers", "body", "pageHeaders"]);
const SEALED = /graft-sealed:[a-z0-9]{12}/;
/** A value a recording hid (never the real one): the live value fills its header instead. */
const PLACEHOLDER = /<redacted>|^\[(set|redacted|masked|hidden|empty|unset|session)\]$/i;

function refuse(reason: string): never {
  throw new Error(`INVALID_INPUT: page call ${reason}`);
}

/** The call as asked for; anything else (an expression, a signer, code) is refused. */
export function parsePageCall(raw: unknown): PageCall {
  if (!raw || typeof raw !== "object") refuse("needs a request");
  const value = raw as Record<string, unknown>;
  const extra = Object.keys(value).find((key) => !KEYS.has(key));
  if (extra) refuse(`takes no ${extra}: it runs no caller code`);
  const request = value.request as Record<string, unknown> | undefined;
  if (!request || typeof request.url !== "string" || typeof request.method !== "string")
    refuse("needs a request url and method");
  const extraRequest = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (extraRequest) refuse(`request takes no ${extraRequest}`);
  if (request.body !== undefined && typeof request.body !== "string") refuse("body must be text");
  return {
    request: {
      url: request.url,
      method: request.method,
      headers: real(stringRecord(request.headers)),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(Array.isArray(request.pageHeaders)
        ? { pageHeaders: request.pageHeaders.filter((name) => typeof name === "string") }
        : {}),
    },
    auth: Array.isArray(value.auth) ? value.auth : [],
    via: value.via === "xhr" ? "xhr" : "fetch",
    crossSite: value.crossSite === true,
  };
}

function real(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => !PLACEHOLDER.test(value)),
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
}

/**
 * The page expression for one call from a tab at `tabUrl`: same-site handles released, the
 * site's own recent sign-in headers merged, and nothing sealed left in it.
 */
export function preparePageCall(
  vault: SealVault,
  tabUrl: string | undefined,
  call: PageCall,
  borrowedFor: (url: string) => Record<string, string>,
): string {
  const crossSite =
    call.crossSite || !tabUrl || !siteOf(tabUrl) || siteOf(tabUrl) !== siteOf(call.request.url);
  const request = vault.release(
    crossSite ? { ...call.request, headers: {} } : call.request,
    call.request.url,
    "page call",
  );
  const arg = {
    ...request,
    // Filtered again after release: a handle can stand for a value a recording had hidden.
    headers: real(crossSite ? safeHeaders(call.request.headers) : request.headers),
    auth: crossSite ? [] : liveAuth(vault, call.auth, call.request.url),
    via: call.via,
    borrowed: crossSite ? {} : real(borrowedFor(call.request.url)),
    crossSite,
  };
  const text = JSON.stringify(arg);
  if (SEALED.test(text))
    throw new Error(
      "SECRET_IN_PAGE_CODE: a sealed value can't be pasted into page code; use page.request(...) " +
        "or browser.fetch(...), which send it to its own site",
    );
  return `(${PAGE_CALL})(${text})`;
}

/**
 * Auth schemes with any sealed constant released for this site. A sealed constant the vault
 * can't release here was learned from a sealed capture: it is dropped, so the value the site's
 * own code sent lately (or the page's anti-forgery token) fills the header instead.
 */
function liveAuth(vault: SealVault, auth: unknown[], url: string): unknown[] {
  return auth.map((item) => {
    const source = (item as { source?: { kind?: unknown; value?: unknown } }).source;
    if (source?.kind !== "constant" || typeof source.value !== "string") return item;
    const value = releasedOrNone(vault, source.value, url);
    if (value === undefined || PLACEHOLDER.test(value)) return withoutSource(item);
    return { ...(item as object), source: { ...source, value } };
  });
}

/** The value with same-site handles released; undefined when it can't be released here. */
function releasedOrNone(vault: SealVault, value: string, url: string): string | undefined {
  if (!SEALED.test(value)) return value;
  try {
    return vault.release(value, url, "page call");
  } catch {
    return undefined;
  }
}

function withoutSource(item: unknown): Record<string, unknown> {
  const { source: _dropped, ...rest } = item as Record<string, unknown>;
  return rest;
}

/** Headers that may go to another site: no sign-in values, nothing sealed. */
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => !SECRET_HEADER.test(name) && !SEALED.test(value),
    ),
  );
}

const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|x-amz-security-token|origin|referer)$|token|secret|session|password|signature|x-.*-key$/i;

/** Runs the call in the tab's page world, where the site's own fetch hooks apply. */
export async function runPageCall(tabId: number, expression: string): Promise<unknown> {
  const result = (await withBrowserDebugger(tabId, (debuggee) =>
    send(
      debuggee,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, silent: true, timeout: 115_000 },
      { label: "pageCall", ms: 120_000 },
    ),
  )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (result.exceptionDetails)
    throw new Error(`NETWORK: the page call failed: ${result.exceptionDetails.text ?? "error"}`);
  return withJson(result.result?.value);
}

/** A JSON answer parsed, as browser.fetch does, so its token fields are sealed like any other. */
export function withJson(value: unknown): unknown {
  const raw = value as { text?: unknown } | undefined;
  if (!raw || typeof raw.text !== "string") return value;
  try {
    const { text: _text, ...rest } = raw;
    return { ...rest, json: JSON.parse(raw.text) as unknown };
  } catch {
    return value;
  }
}

const COOKIE_XSRF = JSON.stringify(COOKIE_XSRF_HEADERS.map((item) => [item.cookie, item.header]));

// Runs in the page. Resolves auth values the page holds (cookies, meta tags, storage), finds an
// anti-forgery token the site's page carries for any header still missing, then calls with the
// page's own fetch or XMLHttpRequest so the site's hooks apply.
/** The in-page call, for tests that check what it does. */
export function pageCallSource(): string {
  return PAGE_CALL;
}

const PAGE_CALL = `async (req) => {
  const COOKIE_XSRF = ${COOKIE_XSRF};
  const pointer = (value, path) => path.split('/').slice(1).reduce((v, k) => v == null ? v : v[k === '*' ? 0 : k.replace(/~1/g, '/').replace(/~0/g, '~')], value);
  const cookie = (name) => { const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '=')); return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined; };
  const headers = { ...req.headers };
  const has = (name) => Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
  for (const auth of req.auth) {
    const s = auth.source; if (!s || headers[auth.key] !== undefined) continue;
    let value;
    if (s.kind === 'meta') value = document.querySelector('meta[name="' + s.name + '"],meta[property="' + s.name + '"]')?.content;
    else if (s.kind === 'cookie') value = cookie(s.name);
    else if (s.kind === 'constant') value = s.value;
    else if (s.kind === 'storage') { const raw = window[s.storage].getItem(s.key); if (raw != null) { if (s.pointer) { try { value = pointer(JSON.parse(raw), s.pointer); } catch {} } else value = raw; } }
    if (value == null || value === '') continue;
    if (auth.type === 'bearer') headers.authorization = /^bearer /i.test(value) ? value : 'Bearer ' + value;
    else if (auth.in === 'header' && auth.key) headers[auth.key] = String(value);
  }
  for (const [name, value] of Object.entries(req.borrowed || {})) if (!has(name)) headers[name] = value;
  if (!req.crossSite) for (const [name, header] of COOKIE_XSRF)
    if (!has(header)) { const value = cookie(name); if (value) headers[header] = value; }
  const csrf = () => {
    const meta = document.querySelector('meta[name="csrf-token"],meta[name="_csrf"],meta[name="csrf"],meta[name="xsrf-token"]') || document.querySelector('meta[name*="csrf" i]');
    if (meta && meta.content) return meta.content;
    const input = document.querySelector('input[type="hidden"][name*="csrf" i],input[type="hidden"][name*="xsrf" i],input[type="hidden"][name="authenticity_token"],input[type="hidden"][name="__RequestVerificationToken"]');
    if (input && input.value) return input.value;
    for (const [name] of COOKIE_XSRF) { const value = cookie(name); if (value) return value; }
  };
  if (!req.crossSite) for (const name of req.pageHeaders || [])
    if (!has(name) && /csrf|xsrf|forgery|verification/i.test(name)) { const value = csrf(); if (value) headers[name] = value; }
  const forbidden = /^(cookie|cookie2|host|origin|referer|user-agent|content-length|connection|accept-encoding|sec-.*|proxy-.*|te|trailer|transfer-encoding|upgrade|via|keep-alive|date|dnt|expect)$/i;
  for (const name of Object.keys(headers)) if (forbidden.test(name)) delete headers[name];
  const credentials = req.crossSite ? 'omit' : 'include';
  if (req.via === 'xhr') return await new Promise((resolve) => {
    const x = new XMLHttpRequest(); x.open(req.method, req.url, true); x.withCredentials = credentials === 'include';
    for (const [k, v] of Object.entries(headers)) { try { x.setRequestHeader(k, v); } catch {} }
    x.onload = () => resolve({ status: x.status, url: x.responseURL, headers: Object.fromEntries(x.getAllResponseHeaders().trim().split(/\\r?\\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()])), text: x.responseText.slice(0, 8000000) });
    x.onerror = () => resolve({ status: 0, headers: {}, text: 'network error' });
    x.send(req.body ?? null);
  });
  const response = await fetch(req.url, { method: req.method, headers, body: req.body, credentials, redirect: 'manual' });
  if (response.type === 'opaqueredirect')
    return { status: 0, url: response.url || req.url, headers: {}, text: '', type: 'opaqueredirect' };
  const location = response.headers.get('location') || '';
  const text = (await response.text()).slice(0, 8000000);
  return { status: response.status, url: response.url || req.url, headers: Object.fromEntries(response.headers), text, location };
}`;
