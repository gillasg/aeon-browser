// A session exported from the user's browser (only when they ask for it): cookies for the
// site's origins plus web storage, so calls can run from Node without a browser.
//
// Copied from site-to-api (`src/runtime/session.ts`) so browser-crawl can stand alone. The file
// format is site-to-api's `~/.site-to-api/sites/<site>/session.json`.

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
