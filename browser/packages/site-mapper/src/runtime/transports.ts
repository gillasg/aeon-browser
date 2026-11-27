import { SECRET_HEADERS } from "../redact.js";
import { isSealedValue } from "../sealed.js";
import { parseJson } from "../infer/schema.js";
import type { SecurityScheme } from "../types.js";
import { sharedBridge, type Bridge } from "./bridge.js";
import { followRedirects, type HopTarget, type SingleHop } from "./net-guard.js";
import { pinnedRequest } from "./pinned-request.js";
import type { RuntimeRequest, RuntimeResponse } from "./request.js";
import { cookieXsrfHeaders } from "../session-headers.js";
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
  /** True when this transport can run now (the page: a browser is connected). */
  connected?(): Promise<boolean>;
  send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse>;
}

/** The request the engine's page call sends (native-browser-page-call.ts): data only, no code. */
export function pageCallRequest(
  request: RuntimeRequest,
  context: CallContext,
  crossSite: boolean,
): Record<string, unknown> {
  return {
    request: {
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.pageHeaders?.length ? { pageHeaders: request.pageHeaders } : {}),
    },
    auth: crossSite ? [] : context.auth,
    via: context.via ?? "fetch",
    crossSite,
  };
}

/**
 * A signed operation: the site's signer computes its own headers in the page. It never sees
 * borrowed sign-in headers, and nothing sealed is pasted into its code.
 */
export function signerExpression(request: RuntimeRequest, signer: string): string {
  const arg = {
    url: request.url,
    method: request.method,
    headers: unsealed(request.headers),
    ...(request.body !== undefined ? { body: request.body } : {}),
  };
  return `(${signer})(${JSON.stringify(arg)})`;
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

  /** True when a browser is connected to call from. */
  async connected(): Promise<boolean> {
    return (await (await this.bridge()).status()).browsers > 0;
  }

  /** The site's tab for `home` in a cell, then `body` run with it as `__tab`. */
  private cell(home: string, body: string): string {
    const origin = JSON.stringify(new URL(home).origin);
    return `
const __store = (globalThis.__siteToApiTabs ??= {});
let __tab = __store[${origin}];
if (__tab) { try { if ((await __tab.inspect(() => location.origin)) !== ${origin}) __tab = undefined; } catch { __tab = undefined; } }
if (!__tab) {
  // The user's own open tab of this origin first (the active one if several): no cold start, no new tab.
  try {
    const __same = (await browser.tabs()).filter((t) => { try { return !t.heldByOther && !t.graftUi && new URL(t.url).origin === ${origin}; } catch { return false; } });
    const __own = __same.find((t) => t.active) || __same[0];
    if (__own) { await browser.attachTab(__own.target); __tab = __own; }
  } catch { __tab = undefined; }
  if (!__tab) __tab = await browser.openTab(${JSON.stringify(home)});
  __store[${origin}] = __tab;
}
${body}`;
  }

  /** Runs `expression` inside the site's tab for `home`, opening a background tab when needed. */
  async inPage(home: string, expression: string, timeoutMs = 120_000): Promise<unknown> {
    const code = this.cell(home, `await __tab.inspect(${JSON.stringify(expression)})`);
    return (await this.bridge()).run(code, { session: this.session, timeoutMs });
  }

  /** One request sent by the engine from the site's tab; the cell never sees sign-in values. */
  async pageCall(home: string, call: Record<string, unknown>): Promise<unknown> {
    const body = `await __call({ pageCall: { target: __tab.target, ...${JSON.stringify(call)} } })`;
    return (await this.bridge()).run(this.cell(home, body), {
      session: this.session,
      timeoutMs: 120_000,
    });
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
    const raw = (
      context.signer && !hop.crossSite
        ? await this.inPage(context.home, signerExpression(next, context.signer))
        : await this.pageCall(context.home, pageCallRequest(next, context, hop.crossSite))
    ) as SingleHop;
    if (!raw || typeof raw.status !== "number") throw new Error("The page returned no response.");
    return raw;
  }
}

/**
 * Plain HTTP from Node, with the user's exported cookies, only when no browser is connected (or
 * the caller asks for it). It claims nothing: no user agent override, no made-up origin or referer.
 */
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
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": this.session?.language ?? "en-US,en;q=0.9",
      ...unsealed(request.headers),
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

/** A sealed handle or redacted value is only real in the page: never sent over plain HTTP. */
function unsealed(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => !isSealedValue(value)));
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
