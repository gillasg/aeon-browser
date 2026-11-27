// Secret sealing and the egress canary. Agent code never holds more secret power than a script
// running on that origin: cookies, auth headers, CSRF tokens, bearer and JWT strings that a step
// answers with (cookies, page.tokens(), network.get/list/har/curl, storage reads) reach the agent
// as opaque handles (`graft-sealed:<id>`), never as raw text. A handle is a plain string, so
// JSON.stringify, toString, logs and error messages can only ever print the handle.
//
// A handle still works where it came from: a fetch, navigation or fill to the same site gets the
// raw value swapped back in by the host. Anything bound for another site that carries a handle
// or a raw sealed value is refused (SECRET_EGRESS). Non-secret egress is never asked about.

export const SEAL_PREFIX = "graft-sealed:";
export const SEALED_RE = /graft-sealed:[a-z0-9]{12}/g;

const SECRET_KEY =
  /^(set-)?cookies?$|authori[sz]ation|^x-[\w-]*(token|csrf|xsrf|auth|key)[\w-]*$|csrf|xsrf|(^|[-_])token$|^token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|secret|session[-_]?id|^sid$|password/i;
const HEADER_LINE =
  /((?:^|[\s'"{,-])(?:authorization|cookie|set-cookie|x-[\w-]*(?:token|csrf|xsrf|auth|key)[\w-]*)\s*:\s*)([^'"\n\\]{4,})/gi;
const COOKIE_FLAG = /(\s(?:-b|--cookie)\s+)(['"])([^'"]{4,})\2/g;
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g;
const BEARER = /\b(Bearer|Basic|Token)\s+([\w~+/.=-]{12,})/g;
const REDACTED_SENTINEL = /^\[(set|redacted|masked|hidden|empty|unset)\]$/i;
const CONTROL_KEYS = ["kind", "role", "label", "selector", "control", "frame", "tag"];
const MAX_SEALS = 2000;

interface Seal {
  value: string;
  site: string | null;
}

/** The registrable part of a host (last two labels; three for short second-level labels like co.uk). */
export function siteOf(hostOrUrl: string | null | undefined): string | null {
  if (!hostOrUrl) return null;
  let host = hostOrUrl.trim().toLowerCase().replace(/^\./, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || /^[\d.]+$/.test(host) || !host.includes(".")) return host || null;
  const labels = host.split(".");
  const take = labels.length > 2 && labels[labels.length - 2]!.length <= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

export class SealVault {
  private readonly seals = new Map<string, Seal>();
  private readonly byValue = new Map<string, string>();

  get size(): number {
    return this.seals.size;
  }

  /** The handle for a raw secret (the same value always gets the same handle). */
  seal(value: string, site: string | null): string {
    if (value.startsWith(SEAL_PREFIX) || REDACTED_SENTINEL.test(value.trim())) return value;
    const known = this.byValue.get(value);
    if (known) return known;
    const handle = SEAL_PREFIX + randomId();
    this.seals.set(handle, { value, site });
    this.byValue.set(value, handle);
    if (this.seals.size > MAX_SEALS) {
      const [oldest, seal] = this.seals.entries().next().value as [string, Seal];
      this.seals.delete(oldest);
      this.byValue.delete(seal.value);
    }
    return handle;
  }

  /** Every secret-shaped string inside free text replaced by its handle. */
  sealText(text: string, site: string | null): string {
    if (!text) return text;
    return text
      .replace(
        HEADER_LINE,
        (_m, head: string, value: string) => head + this.seal(value.trim(), site),
      )
      .replace(
        COOKIE_FLAG,
        (_m, flag: string, quote: string, value: string) =>
          `${flag}${quote}${this.seal(value, site)}${quote}`,
      )
      .replace(BEARER, (_m, kind: string, value: string) => `${kind} ${this.seal(value, site)}`)
      .replace(JWT, (value) => this.seal(value, site));
  }

  /** A deep copy with secret-named fields and secret-shaped strings sealed. */
  sealValue<T>(value: T, site: string | null, kind?: string): T {
    return this.walk(value, site, 0, kind === "cookies") as T;
  }

  private walk(value: unknown, site: string | null, depth: number, cookie: boolean): unknown {
    if (typeof value === "string") return this.sealText(value, site);
    if (!value || typeof value !== "object" || depth > 40) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (Array.isArray(value)) return value.map((item) => this.walk(item, site, depth + 1, cookie));
    const record = value as Record<string, unknown>;
    const here = localSite(record) ?? site;
    const isCookie = cookie || ("name" in record && "value" in record && "domain" in record);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const secret =
        (SECRET_KEY.test(key) && !(key === "token" && isControl(record))) ||
        (isCookie && key === "value") ||
        headerPair(record, key);
      out[key] =
        secret && typeof item === "string" && item.length >= 4
          ? this.seal(item, here)
          : this.walk(item, here, depth + 1, false);
    }
    return out;
  }

  /**
   * Egress check: every handle bound for its own site is swapped back to the raw value; a handle
   * or a raw sealed value bound for another site (or nowhere known) throws SECRET_EGRESS.
   */
  release<T>(value: T, destination: string | null | undefined, what: string): T {
    const dest = siteOf(destination);
    return this.releaseWalk(value, dest, what, 0) as T;
  }

  private releaseWalk(value: unknown, dest: string | null, what: string, depth: number): unknown {
    if (typeof value === "string") return this.releaseText(value, dest, what);
    if (!value || typeof value !== "object" || depth > 40) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (Array.isArray(value))
      return value.map((item) => this.releaseWalk(item, dest, what, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[this.releaseText(key, dest, what)] = this.releaseWalk(item, dest, what, depth + 1);
    return out;
  }

  private releaseText(text: string, dest: string | null, what: string): string {
    const out = text.replace(SEALED_RE, (handle) => {
      const seal = this.seals.get(handle);
      if (!seal) throw egressError(what, dest, "an unknown sealed handle");
      if (!dest || !seal.site || seal.site !== dest)
        throw egressError(what, dest, `a secret sealed for ${seal.site ?? "an unknown site"}`);
      return seal.value;
    });
    for (const seal of this.seals.values())
      if (seal.value.length >= 8 && text.includes(seal.value) && seal.site !== dest)
        throw egressError(what, dest, `a secret sealed for ${seal.site ?? "an unknown site"}`);
    return out;
  }
}

/** A DOM control descriptor: its bare `token` is the element handle, not a credential. */
function isControl(record: Record<string, unknown>): boolean {
  return CONTROL_KEYS.some((key) => key in record);
}

function headerPair(record: Record<string, unknown>, key: string): boolean {
  return key === "value" && typeof record.name === "string" && SECRET_KEY.test(record.name);
}

function localSite(record: Record<string, unknown>): string | null {
  for (const key of ["url", "domain", "origin", "host"]) {
    const value = record[key];
    if (typeof value === "string" && value) return siteOf(value);
  }
  return null;
}

function egressError(what: string, dest: string | null, carried: string): Error {
  return new Error(
    `SECRET_EGRESS: ${what} to ${dest ?? "an unknown site"} carries ${carried}. Sealed secrets ` +
      `only travel back to the site they came from; send the request from that site instead.`,
  );
}

function randomId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(36).padStart(2, "0").slice(-2);
  return out.slice(0, 12).padEnd(12, "0");
}

const vaults = new Map<string, SealVault>();

/** The seal vault for one chat (handles never cross chats). */
export function vaultFor(chatId: string): SealVault {
  let vault = vaults.get(chatId);
  if (!vault) {
    vault = new SealVault();
    vaults.set(chatId, vault);
    if (vaults.size > 200) vaults.delete(vaults.keys().next().value as string);
  }
  return vault;
}
