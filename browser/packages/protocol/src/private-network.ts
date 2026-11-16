// Private-network policy decisions. A name/IP check used before an agent navigation, fetch, or
// mapped-site call, plus a post-hoc check of the address a response came from. Chrome extensions
// cannot block on the resolved address before connecting (there is no per-tab proxy), so rebinding
// on a tab is also recorded from the response address. Direct calls check before they connect.
// One parser covers dotted IPv4, IPv4-mapped IPv6 (dotted and hex), IPv4-compatible IPv6,
// NAT64 64:ff9b::/96, and the unspecified address. A mapped form is the IPv4 it connects to.
const PRIVATE_V4 = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
];
const METADATA = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata.google.internal",
]);

function bareHost(address: string): string {
  return address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function ipv4Reason(address: string): string | undefined {
  if (METADATA.has(address)) return `metadata address ${address}`;
  if (PRIVATE_V4.some((pattern) => pattern.test(address))) return `private address ${address}`;
  return undefined;
}

function parseSide(side: string): number[] | undefined {
  if (!side) return [];
  const groups: number[] = [];
  for (const group of side.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

/** `::ffff:169.254.169.254` as `::ffff:a9fe:a9fe`, or undefined when the dotted tail is not an IPv4. */
function undot(host: string): string | undefined {
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (!dotted) return host;
  const parts = (dotted[2] ?? "").split(".").map((part) => Number(part));
  const a = parts[0] ?? 256;
  const b = parts[1] ?? 256;
  const c = parts[2] ?? 256;
  const d = parts[3] ?? 256;
  if ([a, b, c, d].some((part) => part > 255)) return undefined;
  const hi = a * 256 + b;
  const lo = c * 256 + d;
  return `${dotted[1] ?? ""}${hi.toString(16)}:${lo.toString(16)}`;
}

/** Eight hextets, or undefined when the text is not an IPv6 address. */
function hextets(host: string): number[] | undefined {
  const value = undot(host);
  if (value === undefined) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = parseSide(halves[0] ?? "");
  if (!left) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const right = parseSide(halves[1] ?? "");
  if (!right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function zeros(groups: readonly number[], count: number): boolean {
  return groups.slice(0, count).every((group) => group === 0);
}

function octets(groups: readonly number[]): string {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;
}

/** The IPv4 address an IPv6 form actually connects to, when it is one of those forms. */
function embeddedIpv4(groups: readonly number[]): string | undefined {
  const mapped = zeros(groups, 5) && groups[5] === 0xffff;
  const compatible = zeros(groups, 6);
  const nat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  return mapped || compatible || nat64 ? octets(groups) : undefined;
}

function ipv6Reason(host: string): string | undefined {
  if (host === "::" || host === "::1") return `private address ${host}`;
  const groups = hextets(host);
  if (!groups) return undefined;
  const embedded = embeddedIpv4(groups);
  if (embedded) return ipv4Reason(embedded);
  const first = groups[0] ?? 0;
  if (Math.floor(first / 512) * 512 === 0xfc00) return `private address ${host}`;
  if (Math.floor(first / 64) * 64 === 0xfe80) return `private address ${host}`;
  return undefined;
}

/** The address a socket actually reaches: an embedded IPv4, or one spelling of the IP. */
export function connectionAddress(address: string): string | undefined {
  const value = bareHost(address);
  if (!value) return undefined;
  if (!value.includes(":")) return ipv4Literal(value);
  if (value === "::" || value === "::1") return value;
  const groups = hextets(value);
  if (!groups) return undefined;
  return embeddedIpv4(groups) ?? groups.map((group) => group.toString(16)).join(":");
}

function ipv4Literal(value: string): string | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return undefined;
  const parts = value.split(".").map((part) => Number(part));
  if (parts.some((part) => part > 255)) return undefined;
  return parts.join(".");
}

/** The reason an address is private, metadata or local, or undefined for a public address. */
export function privateAddress(address: string): string | undefined {
  const value = bareHost(address);
  if (!value) return undefined;
  if (METADATA.has(value)) return `metadata address ${value}`;
  if (!value.includes(":")) return ipv4Reason(value);
  return ipv6Reason(value);
}

/** A literal loopback name. Mapped and compatible forms are not this, even when they connect there. */
export function literalLoopback(host: string): boolean {
  const value = bareHost(host);
  return value === "localhost" || value === "::1" || /^127\./.test(value);
}

function portNumber(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/** True when an agent must not open this URL unless the policy is explicitly off. */
export function privateTarget(url: string, allowPorts: readonly number[] = []): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = bareHost(parsed.hostname);
  if (/\.(local|internal)$/.test(host)) return `private host ${host}`;
  if (literalLoopback(host))
    return allowPorts.includes(portNumber(parsed)) ? undefined : `private address ${host}`;
  return privateAddress(host);
}

/**
 * What to do before connecting. "allow" is only a literal loopback on an allowlisted port.
 * "resolve" means the name still has to be looked up. Anything else is a refusal reason.
 * A private address that privateTarget did not already allow is a refusal, never an allow.
 */
export function preflightHost(
  url: string,
  allowPorts: readonly number[] = [],
): "allow" | "resolve" | string {
  const literal = privateTarget(url, allowPorts);
  if (literal) return literal;
  let host: string;
  try {
    host = bareHost(new URL(url).hostname);
  } catch {
    return "invalid url";
  }
  if (literalLoopback(host)) return "allow";
  const blocked = privateAddress(host);
  if (blocked) return blocked;
  return "resolve";
}

/**
 * Resolved addresses are refused even on an allowed loopback port: only a literal
 * localhost/127.0.0.1 gets the development allowlist. A public-looking hostname that resolves
 * into the private network (nip.io, a hosts entry, split-horizon DNS) is the rebinding case.
 */
export function resolvedTarget(host: string, addresses: readonly string[]): string | undefined {
  for (const address of addresses) {
    const reason = privateAddress(address);
    if (reason) return `resolved ${host} to ${reason}`;
  }
  return undefined;
}
