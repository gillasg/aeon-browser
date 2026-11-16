// A mapped call carries the user's cookies. An open redirect on that site can aim the next hop
// at a router, a cloud-metadata address, or another origin. Direct calls and page calls check
// every hop before it is sent. A write that already left is not sent again to a different site;
// the error names that site. Refusal is a reason, never a permission prompt.
import { lookup } from "node:dns/promises";
import {
  connectionAddress,
  privateAddress,
  privateTarget,
  resolvedTarget,
} from "@browserkit/protocol";

export type Reach = "public" | "loopback" | "local";
export type Resolver = (host: string) => Promise<readonly string[]>;

const MAX_HOPS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export class RedirectRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectRefused";
  }
}

export interface SingleHop {
  status: number;
  headers: Record<string, string>;
  text?: string;
  url?: string;
  location?: string;
  /** Set when the browser hid a redirect (`opaqueredirect`). There is no Location to follow. */
  type?: string;
}

export interface HopTarget {
  url: string;
  method: string;
  body?: string;
  /** True when this hop's origin is not the call's origin. Auth headers must not ride along. */
  crossSite: boolean;
  /** Address the guard checked. The transport connects here and does not resolve the name again. */
  address: string;
  /** Original hostname, used for the Host header and TLS SNI. */
  host: string;
  /** Public reach refuses a private or mapped peer even when it is the pin. */
  publicReach: boolean;
}

interface CheckedHop {
  host: string;
  address: string;
}

export interface FollowInput {
  url: string;
  method: string;
  body?: string;
  home: string;
  resolve?: Resolver;
  request: (target: HopTarget) => Promise<SingleHop>;
}

/** Where a site's own calls may go, from the page they were recorded on. */
export function reachOf(home: string): Reach {
  try {
    const host = hostname(new URL(home));
    if (isLoopback(host)) return "loopback";
    if (isLan(host)) return "local";
  } catch {
    // A home that is not a URL is treated as public, so a private hop stays refused.
  }
  return "public";
}

/** A read may retry. A write, a dead browser, or a refused redirect must not. */
export function stopsRetry(
  readOnly: boolean,
  error: unknown,
  attempt: number,
  retries: number,
): boolean {
  const offline = error instanceof Error && error.name === "BrowserNotConnected";
  return !readOnly || offline || error instanceof RedirectRefused || attempt >= retries;
}

export function isWrite(method: string): boolean {
  const name = method.toUpperCase();
  return name !== "GET" && name !== "HEAD";
}

/**
 * Same host, and either the same port or an http↔https change on the default ports.
 * A write may follow an http→https upgrade. An https→http downgrade is a different site:
 * the body and cookies must not be sent again in cleartext.
 */
export function sameSite(from: string, to: string, write = false): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(from);
    right = new URL(to);
  } catch {
    return false;
  }
  if (hostname(left) !== hostname(right)) return false;
  return samePort(left, right, write);
}

/**
 * Why this hop must not be connected to, or undefined when it is in reach.
 * `resolve` defaults to the machine's resolver; tests pass a fixed answer.
 */
export async function hopRefusal(
  url: string,
  reach: Reach,
  resolve: Resolver = resolveHost,
): Promise<string | undefined> {
  const checked = await checkHop(url, reach, resolve);
  return typeof checked === "string" ? checked : undefined;
}

/** One request, then each redirect, stopping at a private hop or a cross-site write. */
export async function followRedirects(input: FollowInput): Promise<SingleHop> {
  let url = input.url;
  let method = input.method;
  let body = input.body;
  const reach = reachOf(input.home);
  const write = isWrite(input.method);
  const publicReach = reach === "public";
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const checked = await assertHop(url, reach, input.resolve, hop > 0, write);
    const response = await input.request(
      hopTarget(input.url, url, method, body, checked, publicReach),
    );
    if (response.type === "opaqueredirect") opaqueRedirect(method, url, write);
    if (write && hop > 0 && response.status >= 400) refuseFollowUp(input.method, input.url, url);
    const next = nextUrl(response, url, method);
    if (!next) return response;
    if (hop === MAX_HOPS) refuseMany(url, next, write);
    ({ method, body } = shifted(method, body, response.status));
    url = next;
  }
  throw new RedirectRefused(`PRIVATE_NETWORK: too many redirects toward ${url}`);
}

function hopTarget(
  start: string,
  url: string,
  method: string,
  body: string | undefined,
  checked: CheckedHop,
  publicReach: boolean,
): HopTarget {
  const target: HopTarget = {
    url,
    method,
    crossSite: !sameSite(start, url),
    address: checked.address,
    host: checked.host,
    publicReach,
  };
  const sent = sendBody(method, body);
  if (sent !== undefined) target.body = sent;
  return target;
}

async function checkHop(
  url: string,
  reach: Reach,
  resolve: Resolver,
): Promise<CheckedHop | string> {
  const parsed = parseHttp(url);
  if (typeof parsed === "string") return parsed;
  const host = hostname(parsed);
  const literal = literalRefusal(host, reach);
  if (literal) return literal;
  if (isIp(host)) return pinLiteral(host);
  return pinName(host, reach, resolve);
}

function pinLiteral(host: string): CheckedHop | string {
  if (!connectionAddress(host)) return `could not parse address ${host}`;
  return { host, address: host };
}

async function pinName(
  host: string,
  reach: Reach,
  resolve: Resolver,
): Promise<CheckedHop | string> {
  const addresses = await resolve(host).catch(() => [] as string[]);
  if (!addresses.length) return `could not resolve ${host}`;
  const reason = refusedAnswers(host, addresses, reach);
  if (reason) return reason;
  const address = addresses[0];
  if (!address || !connectionAddress(address)) return `could not resolve ${host}`;
  return { host, address };
}

/** Every answer is checked. One private, mapped, or non-address answer refuses the lookup. */
function refusedAnswers(
  host: string,
  addresses: readonly string[],
  reach: Reach,
): string | undefined {
  const reason = addressRefusal(host, addresses, reach);
  if (reason) return reason;
  for (const address of addresses) {
    if (!connectionAddress(address)) return `resolved ${host} to a non-address`;
  }
  return undefined;
}

async function assertHop(
  url: string,
  reach: Reach,
  resolve: Resolver | undefined,
  redirected: boolean,
  write: boolean,
): Promise<CheckedHop> {
  const checked = await checkHop(url, reach, resolve ?? resolveHost);
  if (typeof checked !== "string") return checked;
  if (redirected && write)
    throw new RedirectRefused(
      `outcome_unknown: redirected to ${url} was not followed (${checked})`,
    );
  if (redirected)
    throw new RedirectRefused(`PRIVATE_NETWORK: redirect to ${url} was not followed (${checked})`);
  throw new RedirectRefused(`PRIVATE_NETWORK: ${checked}`);
}

function nextUrl(response: SingleHop, from: string, method: string): string | undefined {
  if (!REDIRECT.has(response.status)) return undefined;
  if (!response.location) hidden(from, method, response.status);
  const next = new URL(response.location ?? "", from).href;
  if (!isWrite(method)) return next;
  if (!sameSite(from, next, true)) crossSiteWrite(from, next, method, response.status);
  if (response.status === 307 || response.status === 308)
    keptWrite(from, next, method, response.status);
  return next;
}

function hidden(from: string, method: string, status: number): never {
  const message = `${method} ${from} answered HTTP ${status} with a redirect whose target was hidden; the redirect was not followed`;
  throw new RedirectRefused(isWrite(method) ? `outcome_unknown: ${message}` : message);
}

function crossSiteWrite(from: string, next: string, method: string, status: number): never {
  throw new RedirectRefused(
    `outcome_unknown: ${method} ${from} answered HTTP ${status} and redirected to ${next}; the redirect was not followed`,
  );
}

function keptWrite(from: string, next: string, method: string, status: number): never {
  throw new RedirectRefused(
    `outcome_unknown: ${method} ${from} answered HTTP ${status} and redirected to ${next}; the redirect was not followed because a write body is not sent twice. Next: await page.network.list() or read the page.`,
  );
}

function opaqueRedirect(method: string, url: string, write: boolean): never {
  const message = `${method} ${url} was sent and the browser hid the redirect. Next: await page.network.list() or read the page.`;
  throw new RedirectRefused(write ? `outcome_unknown: ${message}` : message);
}

function refuseFollowUp(method: string, from: string, url: string): never {
  throw new RedirectRefused(
    `outcome_unknown: ${method} ${from} was sent and the follow-up read of ${url} did not succeed; that read is not a rejection of the write. Next: await page.network.list() or read the page.`,
  );
}

function refuseMany(from: string, next: string, write: boolean): never {
  const message = `redirect from ${from} toward ${next} was not followed: too many hops`;
  throw new RedirectRefused(write ? `outcome_unknown: ${message}` : `PRIVATE_NETWORK: ${message}`);
}

function shifted(
  method: string,
  body: string | undefined,
  status: number,
): { method: string; body?: string } {
  // 301/302/303 drop the body for every method. 307/308 of a write are not followed.
  if (status === 301 || status === 302 || status === 303) return { method: "GET" };
  return body === undefined ? { method } : { method, body };
}

function sendBody(method: string, body?: string): string | undefined {
  const name = method.toUpperCase();
  if (name === "GET" || name === "HEAD") return undefined;
  return body;
}

function literalRefusal(host: string, reach: Reach): string | undefined {
  const blocked = metadataOrLinkLocal(host);
  if (blocked) return blocked;
  if (reach === "public") return privateTarget(hostUrl(host));
  if (reach === "loopback") return isLoopback(host) ? undefined : privateAddress(host);
  if (isLoopback(host)) return `private address ${host}`;
  return isLan(host) ? undefined : privateAddress(host);
}

function addressRefusal(
  host: string,
  addresses: readonly string[],
  reach: Reach,
): string | undefined {
  if (reach === "public") return resolvedTarget(host, addresses);
  for (const address of addresses) {
    const reason = kept(address, reach);
    if (reason) return `resolved ${host} to ${reason}`;
  }
  return undefined;
}

function kept(address: string, reach: Reach): string | undefined {
  const meta = metadataOrLinkLocal(address);
  if (meta) return meta;
  const reason = privateAddress(address);
  if (!reason) return undefined;
  if (reach === "loopback" && isLoopback(address)) return undefined;
  if (reach === "local" && isLan(address)) return undefined;
  return reason;
}

function metadataOrLinkLocal(host: string): string | undefined {
  const reason = privateAddress(host);
  if (reason?.startsWith("metadata")) return reason;
  if (/^169\.254\./.test(host) || /^fe[89ab]/i.test(host)) return `link-local address ${host}`;
  if (/\.(local|internal)$/.test(host)) return `private host ${host}`;
  return undefined;
}

function isLan(host: string): boolean {
  if (metadataOrLinkLocal(host) || isLoopback(host)) return false;
  return Boolean(privateAddress(host));
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function samePort(left: URL, right: URL, write: boolean): boolean {
  if (portOf(left) === portOf(right)) return true;
  if (!defaultPair(left, right)) return false;
  if (left.protocol === "http:" && right.protocol === "https:") return true;
  return !write && left.protocol === "https:" && right.protocol === "http:";
}

function defaultPair(left: URL, right: URL): boolean {
  const ports = `${portOf(left)}>${portOf(right)}`;
  return ports === "80>443" || ports === "443>80";
}

function portOf(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

function hostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function hostUrl(host: string): string {
  return host.includes(":") ? `http://[${host}]/` : `http://${host}/`;
}

function parseHttp(url: string): URL | string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid url";
    return parsed;
  } catch {
    return "invalid url";
  }
}

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}
