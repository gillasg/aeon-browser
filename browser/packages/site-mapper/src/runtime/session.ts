// A session exported from the user's browser (only when they ask for it): cookies for the
// site's origins plus web storage, so calls can run from Node without a browser.

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** When true, the cookie belongs to one host only (RFC 6265). CDP cookies omit this field. */
  hostOnly?: boolean;
  /** Seconds since the epoch; -1 or missing for session cookies. */
  expires?: number;
}

export interface SessionFile {
  site: string;
  savedAt: string;
  userAgent?: string;
  language?: string;
  cookies: SessionCookie[];
  /** By origin. */
  localStorage?: Record<string, Record<string, string>>;
  sessionStorage?: Record<string, Record<string, string>>;
}

/**
 * RFC 6265: a host-only cookie matches just its exact host. A leading dot marks a domain cookie,
 * which also covers subdomains. CDP cookies have no `hostOnly` field, so the leading dot is the
 * only signal there — a bare domain must never be sent to a lookalike or a subdomain.
 */
function domainMatches(host: string, domain: string, hostOnly?: boolean): boolean {
  const bare = domain.replace(/^\./, "");
  if (hostOnly === true) return host === bare;
  if (!domain.startsWith(".")) return host === domain;
  return host === bare || host.endsWith("." + bare);
}

export function cookieHeader(session: SessionFile, url: string): string {
  const target = new URL(url);
  const now = Date.now() / 1000;
  return session.cookies
    .filter(
      (cookie) =>
        domainMatches(target.hostname, cookie.domain, cookie.hostOnly) &&
        target.pathname.startsWith(cookie.path || "/") &&
        (!cookie.secure ||
          target.protocol === "https:" ||
          target.hostname === "localhost" ||
          target.hostname === "127.0.0.1") &&
        (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > now),
    )
    .sort((a, b) => (b.path || "/").length - (a.path || "/").length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function applyAttribute(cookie: SessionCookie, attribute: string): void {
  const [key = "", value = ""] = attribute.split("=").map((part) => part.trim());
  const name = key.toLowerCase();
  if (name === "domain" && value) cookie.domain = value;
  else if (name === "path" && value) cookie.path = value;
  else if (name === "secure") cookie.secure = true;
  else if (name === "httponly") cookie.httpOnly = true;
  else if (name === "max-age") cookie.expires = Date.now() / 1000 + Number(value);
  else if (name === "expires" && cookie.expires === undefined)
    cookie.expires = Date.parse(value) / 1000;
}

const sameCookie = (a: SessionCookie, b: SessionCookie) =>
  a.name === b.name &&
  a.path === b.path &&
  a.domain.replace(/^\./, "") === b.domain.replace(/^\./, "");

/** Applies Set-Cookie headers so a session keeps working as the site rotates cookies. */
export function storeSetCookies(session: SessionFile, url: string, headers: string[]): void {
  const host = new URL(url).hostname;
  for (const header of headers) {
    const [pair = "", ...attributes] = header.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const cookie: SessionCookie = {
      name: pair.slice(0, index).trim(),
      value: pair.slice(index + 1).trim(),
      domain: host,
      path: "/",
    };
    for (const attribute of attributes) applyAttribute(cookie, attribute);
    session.cookies = session.cookies.filter((existing) => !sameCookie(existing, cookie));
    session.cookies.push(cookie);
  }
}

/** Browser code that reads the session for a list of origins from one of the site's tabs. */
export function sessionExportExpression(): string {
  return `(async () => ({
    userAgent: navigator.userAgent,
    language: navigator.languages.join(','),
    origin: location.origin,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
  }))()`;
}
