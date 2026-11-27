import { SECRET_HEADERS } from "../redact.js";
import { parseJson } from "../infer/schema.js";
import type { SecurityScheme } from "../types.js";
import { sharedBridge, type Bridge } from "./bridge.js";
import { followRedirects, type HopTarget, type SingleHop } from "./net-guard.js";
import { pinnedRequest } from "./pinned-request.js";
import type { RuntimeRequest, RuntimeResponse } from "./request.js";
import { COOKIE_XSRF_HEADERS, cookieXsrfHeaders } from "../session-headers.js";
import { cookieHeader, storeSetCookies, type SessionFile } from "./session.js";

// Two ways to make a call:
// - page: inside one of the site's own tabs in the user's browser. Cookies, CORS, CSRF and any
//   signing the site's code adds to fetch or XMLHttpRequest all apply. Works behind every login.
// - direct: from Node with an exported session (or nothing, for public endpoints). Fast and
//   needs no browser, but signed requests and fresh logins need the page.

export interface CallContext {
  /** Security schemes the operation uses, resolved by the transport where possible. */
  auth: SecurityScheme[];
  /** The page the site makes this call from: the tab is opened there. */
  home: string;
  via?: "fetch" | "xhr";
  /** In-page code that makes the call itself: `async (request) => ({ status, json })`. */
  signer?: string;
}

export interface Transport {
  readonly name: "page" | "direct";
  send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse>;
}

// Runs in the page. Resolves auth values the page holds (cookies, meta tags, storage), then
// calls with the page's own fetch or XMLHttpRequest so the site's hooks apply.
const PAGE_CALL = `async (req) => {
  const COOKIE_XSRF = COOKIE_XSRF_PAIRS;
  const pointer = (value, path) => path.split('/').slice(1).reduce((v, k) => v == null ? v : v[k === '*' ? 0 : k.replace(/~1/g, '/').replace(/~0/g, '~')], value);
  const cookie = (name) => { const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '=')); return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined; };
  const headers = { ...req.headers };
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
  // The sign-in header the site's own code sent from this browser lately, for sites that keep it
  // in memory where no recipe can read it (filled in by the page transport; never saved).
  for (const [name, value] of Object.entries(typeof req.borrowed === 'object' && req.borrowed || {}))
    if (!Object.keys(headers).some((key) => key.toLowerCase() === name)) headers[name] = value;
  // Anti-forgery headers the site's own code copies from a cookie, read from the live jar now.
  if (!req.crossSite) for (const [name, header] of COOKIE_XSRF)
    if (!Object.keys(headers).some((key) => key.toLowerCase() === header)) { const value = cookie(name); if (value) headers[header] = value; }
  const forbidden = /^(cookie|cookie2|host|origin|referer|user-agent|content-length|connection|accept-encoding|sec-.*|proxy-.*|te|trailer|transfer-encoding|upgrade|via|keep-alive|date|dnt|expect)$/i;
  for (const name of Object.keys(headers)) if (forbidden.test(name)) delete headers[name];
  if (req.crossSite) {
    const secret = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|x-amz-security-token)$|token|secret|session|password|signature|x-.*-key$/i;
    for (const name of Object.keys(headers)) if (secret.test(name) || /^(origin|referer)$/i.test(name)) delete headers[name];
  }
  const credentials = req.crossSite ? 'omit' : 'include';
  const request = { url: req.url, method: req.method, headers, body: req.body };
  if (req.signer) return await (SIGNER)(request);
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
  const headersOut = Object.fromEntries(response.headers);
  const location = response.headers.get('location') || '';
  const text = (await response.text()).slice(0, 8000000);
  return { status: response.status, url: response.url || req.url, headers: headersOut, text, location };
}`;

/** Stands in the call expression for the borrowed sign-in headers; the browser code fills it. */
const BORROWED = "__SITE_TO_API_BORROWED_HEADERS__";

export function pageCallExpression(
  request: RuntimeRequest,
  context: CallContext,
  bare = false,
): string {
  const arg = {
    ...request,
    auth: bare ? [] : context.auth,
    via: context.via ?? "fetch",
    signer: bare ? undefined : context.signer ? true : undefined,
    borrowed: bare ? {} : BORROWED,
    crossSite: bare,
  };
  const fn = PAGE_CALL.replace("(SIGNER)", `(${context.signer ?? "null"})`).replace(
    "COOKIE_XSRF_PAIRS",
    JSON.stringify(COOKIE_XSRF_HEADERS.map((item) => [item.cookie, item.header])),
  );
  return `(${fn})(${JSON.stringify(arg)})`;
}

function finish(raw: {
  status: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
  url?: string;
}): RuntimeResponse {
  const response: RuntimeResponse = { status: raw.status, headers: raw.headers ?? {} };
  if (raw.url) response.url = raw.url;
  if (raw.json !== undefined) response.json = raw.json;
  else {
    const json = parseJson(raw.text);
    if (json !== undefined) response.json = json;
    else if (raw.text !== undefined) response.text = raw.text;
  }
  return response;
}

/** Keeps one tab per site page origin: the user's open tab of it when there is one, else a background
 * tab opened on first use, reused after. */
export class PageTransport implements Transport {
  readonly name = "page" as const;

  constructor(
    private readonly bridge: () => Promise<Bridge> = sharedBridge,
    private readonly session = "site-to-api",
  ) {}

  /**
   * Runs `expression` inside the site's tab for `home`, opening the tab when needed. With
   * `borrowFor`, the browser's in-memory sign-in headers for that URL's origin replace the
   * borrowed-headers placeholder first (engines without them leave it empty).
   */
  async inPage(
    home: string,
    expression: string,
    timeoutMs = 120_000,
    borrowFor?: string,
  ): Promise<unknown> {
    const origin = new URL(home).origin;
    const borrow = borrowFor
      ? `let __borrowed = {};
try { if (typeof __call === 'function') __borrowed = (await __call({network: 'session-headers', target: __tab.target, url: ${JSON.stringify(borrowFor)}})) || {}; } catch {}
`
      : "";
    const run = borrowFor
      ? `${JSON.stringify(expression)}.replace(${JSON.stringify(JSON.stringify(BORROWED))}, JSON.stringify(__borrowed))`
      : JSON.stringify(expression);
    const code = `
const __store = (globalThis.__siteToApiTabs ??= {});
let __tab = __store[${JSON.stringify(origin)}];
if (__tab) { try { if ((await __tab.inspect(() => location.origin)) !== ${JSON.stringify(origin)}) __tab = undefined; } catch { __tab = undefined; } }
if (!__tab) {
  // The user's own open tab of this origin first (the active one if several): no cold start, no new tab.
  try {
    const __same = (await browser.tabs()).filter((t) => { try { return !t.heldByOther && !t.graftUi && new URL(t.url).origin === ${JSON.stringify(origin)}; } catch { return false; } });
    const __own = __same.find((t) => t.active) || __same[0];
    if (__own) { await browser.attachTab(__own.target); __tab = __own; }
  } catch { __tab = undefined; }
  if (!__tab) __tab = await browser.openTab(${JSON.stringify(home)});
  __store[${JSON.stringify(origin)}] = __tab;
}
${borrow}await __tab.inspect(${run})`;
    return (await this.bridge()).run(code, { session: this.session, timeoutMs });
  }

  async send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse> {
    const raw = await followRedirects({
      url: request.url,
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
      home: context.home,
      request: (hop) => this.pageHop(request, context, hop),
    });
    return finish(raw);
  }

  private async pageHop(
    request: RuntimeRequest,
    context: CallContext,
    hop: HopTarget,
  ): Promise<SingleHop> {
    const next: RuntimeRequest = { ...request, url: hop.url, method: hop.method };
    if (hop.crossSite) next.headers = crossSiteHeaders(next.headers);
    if (hop.body !== undefined) next.body = hop.body;
    else delete next.body;
    const raw = (await this.inPage(
      context.home,
      pageCallExpression(next, context, hop.crossSite),
      120_000,
      hop.crossSite ? undefined : hop.url,
    )) as SingleHop;
    if (!raw || typeof raw.status !== "number") throw new Error("The page returned no response.");
    return raw;
  }
}

/**
 * What plain HTTP from Node says it is. Never a Chrome string: Node's TLS handshake is not
 * Chrome's, and a site that sees a Chrome UA on a non-Chrome handshake treats it as a forged
 * client (429s, walls). A call that needs to look like the browser goes through the page.
 */
export const DIRECT_USER_AGENT = "graft/0.2";

/** Plain HTTP from Node, with the user's exported cookies and an honest user agent. */
export class DirectTransport implements Transport {
  readonly name = "direct" as const;

  constructor(private session?: SessionFile) {}

  /** Swaps in a renewed session. */
  useSession(session: SessionFile): void {
    this.session = session;
  }

  private sessionValue(
    source: NonNullable<SecurityScheme["source"]>,
    home: string,
  ): string | undefined {
    if (source.kind === "constant") return source.value;
    if (source.kind === "cookie")
      return this.session?.cookies.find((c) => c.name === source.name)?.value;
    if (source.kind === "storage") return storageValue(this.session, new URL(home).origin, source);
    return undefined;
  }

  private authHeaders(context: CallContext, headers: Record<string, string>): void {
    for (const auth of context.auth) {
      if (!auth.source || !auth.key || headers[auth.key] !== undefined) continue;
      const value = this.sessionValue(auth.source, context.home);
      if (!value) continue;
      if (auth.type === "bearer")
        headers.authorization = /^bearer /i.test(value) ? value : `Bearer ${value}`;
      else if (auth.in === "header") headers[auth.key] = value;
    }
  }

  async send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse> {
    const home = new URL(context.home);
    const headers: Record<string, string> = {
      "user-agent": DIRECT_USER_AGENT,
      accept: "application/json, text/plain, */*",
      "accept-language": this.session?.language ?? "en-US,en;q=0.9",
      origin: home.origin,
      referer: home.href,
      ...request.headers,
    };
    this.authHeaders(context, headers);
    // Same as the page: the session's XSRF cookie goes into the header the site expects.
    const host = new URL(request.url).hostname;
    const jar = (this.session?.cookies ?? []).filter((item) =>
      host.endsWith(item.domain.replace(/^\./, "")),
    );
    Object.assign(
      headers,
      cookieXsrfHeaders((name) => jar.find((item) => item.name === name)?.value, headers),
    );
    const raw = await followRedirects({
      url: request.url,
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
      home: context.home,
      request: (hop) => this.oneHop(headers, hop),
    });
    return finish(raw);
  }

  private async oneHop(headers: Record<string, string>, hop: HopTarget): Promise<SingleHop> {
    const hopHeaders = hopHeadersFor(headers, hop.crossSite);
    const cookies = this.session && !hop.crossSite ? cookieHeader(this.session, hop.url) : "";
    if (cookies) hopHeaders.cookie = cookies;
    const response = await pinnedRequest({
      url: hop.url,
      method: hop.method,
      headers: hopHeaders,
      ...(hop.body !== undefined ? { body: hop.body } : {}),
      address: hop.address,
      host: hop.host,
      publicReach: hop.publicReach,
    });
    if (this.session) storeSetCookies(this.session, hop.url, response.setCookies);
    const redirect = response.status >= 300 && response.status < 400;
    return {
      status: response.status,
      url: hop.url,
      headers: response.headers,
      location: response.location,
      ...(redirect ? {} : { text: response.text }),
    };
  }
}

function hopHeadersFor(
  headers: Record<string, string>,
  crossSite: boolean,
): Record<string, string> {
  return crossSite ? crossSiteHeaders(headers) : dropCookie(headers);
}

/** Headers that may leave the call's origin. Secrets, cookies, and origin stay behind. */
export function crossSiteHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return !SECRET_HEADERS.test(lower) && lower !== "origin" && lower !== "referer";
    }),
  );
}

function dropCookie(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "cookie"),
  );
}

function storageValue(
  session: SessionFile | undefined,
  origin: string,
  source: { storage: "localStorage" | "sessionStorage"; key: string; pointer?: string },
): string | undefined {
  const raw = session?.[source.storage]?.[origin]?.[source.key];
  if (raw === undefined || !source.pointer) return raw;
  let value: unknown = parseJson(raw);
  for (const key of source.pointer.split("/").slice(1))
    value = (value as Record<string, unknown> | undefined)?.[key === "*" ? "0" : key];
  return value === undefined || value === null ? undefined : String(value);
}
