// Named cookie jars per site origin ("personal", "work", "client-a"): save the live session under a
// name, switch to another, list, see which is current, remove one. Only cookies the origin's host
// would receive are touched: host-only cookies for that exact host and domain cookies for it or a
// parent domain. Every other site's cookies stay as they are. Jars live in extension local storage
// (the same machine and trust boundary as the cookie store itself). Results carry metadata only:
// account names, the origin, cookie counts, update times and which one is active. Never a value.

export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  storeId?: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}

interface Jar {
  cookies: JarCookie[];
  updatedAt: number;
}
interface OriginJars {
  active?: string;
  jars: Record<string, Jar>;
}
export interface AccountStoreData {
  version: 1;
  origins: Record<string, OriginJars>;
}

export interface AccountSummary {
  account: string;
  origin: string;
  cookies: number;
  updatedAt: string;
  active: boolean;
}

/** The cookie and storage calls the jars need; chrome.cookies and chrome.storage.local in the browser. */
export interface AccountDeps {
  getAll(): Promise<JarCookie[]>;
  set(details: Record<string, unknown>): Promise<unknown>;
  remove(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: unknown;
  }): Promise<unknown>;
  load(): Promise<AccountStoreData | undefined>;
  save(data: AccountStoreData): Promise<void>;
  now?: () => number;
}

export type AccountAction = "save" | "switch" | "list" | "current" | "remove";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORAGE_KEY = "graft.accountJars";

/** The origin a jar belongs to: scheme and host (and port), never a path. */
export function jarOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error(`ACCOUNTS_ORIGIN: not a site address: ${input}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("ACCOUNTS_ORIGIN: only http and https sites have cookie jars");
  return url.origin;
}

/** True when the origin's host would receive this cookie (RFC 6265 domain matching). */
export function cookieBelongsTo(
  cookie: Pick<JarCookie, "domain" | "hostOnly">,
  host: string,
): boolean {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  if (cookie.hostOnly) return domain === target;
  return target === domain || target.endsWith(`.${domain}`);
}

/** The details chrome.cookies.set needs to recreate a cookie exactly; host-only stays host-only. */
export function restoreDetails(cookie: JarCookie): Record<string, unknown> {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    // Leaving out domain is what keeps a host-only cookie off the site's subdomains.
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    ...(cookie.session || cookie.expirationDate === undefined
      ? {}
      : { expirationDate: cookie.expirationDate }),
    ...(cookie.storeId ? { storeId: cookie.storeId } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

function removeDetails(cookie: JarCookie) {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    ...(cookie.storeId ? { storeId: cookie.storeId } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

function keep(cookie: JarCookie): JarCookie {
  const copy: JarCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
  };
  if (cookie.expirationDate !== undefined) copy.expirationDate = cookie.expirationDate;
  if (cookie.storeId) copy.storeId = cookie.storeId;
  if (cookie.partitionKey) copy.partitionKey = cookie.partitionKey;
  return copy;
}

export function accountName(value: unknown): string {
  const name = String(value ?? "");
  if (!NAME.test(name))
    throw new Error("ACCOUNTS_NAME: an account is 1-64 letters, digits, '.', '_' or '-'");
  return name;
}

export class AccountJars {
  readonly #deps: AccountDeps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  /** One action at a time, so two switches never interleave their removes and sets. */
  run(action: AccountAction, site: string, account?: string): Promise<unknown> {
    const next = this.#queue.then(() => this.#run(action, site, account));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #run(action: AccountAction, site: string, account?: string): Promise<unknown> {
    const origin = jarOrigin(site);
    const data = (await this.#deps.load()) ?? { version: 1, origins: {} };
    const entry = data.origins[origin] ?? { jars: {} };
    switch (action) {
      case "list":
        return { origin, accounts: this.#summaries(origin, entry) };
      case "current":
        return { origin, current: entry.active ?? null };
      case "save": {
        const name = accountName(account ?? entry.active);
        entry.jars[name] = { cookies: await this.#live(origin), updatedAt: this.#now() };
        entry.active = name;
        await this.#store(data, origin, entry);
        return { saved: this.#summary(origin, entry, name) };
      }
      case "remove": {
        const name = accountName(account);
        if (!entry.jars[name]) return { removed: false, origin, account: name };
        delete entry.jars[name];
        if (entry.active === name) delete entry.active;
        await this.#store(data, origin, entry);
        // The live session is left alone: removing a jar forgets it, it does not sign out.
        return { removed: true, origin, account: name };
      }
      case "switch":
        return this.#switch(data, origin, entry, accountName(account));
    }
  }

  async #switch(data: AccountStoreData, origin: string, entry: OriginJars, name: string) {
    const target = entry.jars[name];
    if (!target) throw new Error(`ACCOUNTS_UNKNOWN: no saved account "${name}" for ${origin}`);
    const live = await this.#live(origin);
    // The live session goes back into the account it belongs to, so nothing is lost by switching.
    if (entry.active && entry.active !== name && entry.jars[entry.active])
      entry.jars[entry.active] = { cookies: live, updatedAt: this.#now() };
    const now = this.#now() / 1000;
    const wanted = target.cookies.filter(
      (cookie) =>
        cookie.session || cookie.expirationDate === undefined || cookie.expirationDate > now,
    );
    try {
      await this.#replace(live, wanted);
    } catch (error) {
      // All or nothing: put the session that was live back before reporting the failure.
      await this.#replace(await this.#live(origin), live).catch(() => undefined);
      throw new Error(
        `ACCOUNTS_SWITCH: ${String((error as Error)?.message ?? error)}; the previous session was restored`,
      );
    }
    entry.active = name;
    await this.#store(data, origin, entry);
    return {
      switched: this.#summary(origin, entry, name),
      ...(wanted.length < target.cookies.length
        ? { expiredSkipped: target.cookies.length - wanted.length }
        : {}),
    };
  }

  async #replace(current: JarCookie[], next: JarCookie[]): Promise<void> {
    for (const cookie of current) await this.#deps.remove(removeDetails(cookie));
    for (const cookie of next) {
      const set = await this.#deps.set(restoreDetails(cookie));
      if (!set) throw new Error(`the browser refused cookie ${cookie.name} for ${cookie.domain}`);
    }
  }

  async #live(origin: string): Promise<JarCookie[]> {
    const host = new URL(origin).hostname;
    return (await this.#deps.getAll()).filter((cookie) => cookieBelongsTo(cookie, host)).map(keep);
  }

  async #store(data: AccountStoreData, origin: string, entry: OriginJars) {
    if (Object.keys(entry.jars).length) data.origins[origin] = entry;
    else delete data.origins[origin];
    await this.#deps.save(data);
  }

  #summaries(origin: string, entry: OriginJars): AccountSummary[] {
    return Object.keys(entry.jars)
      .sort()
      .map((name) => this.#summary(origin, entry, name));
  }

  #summary(origin: string, entry: OriginJars, name: string): AccountSummary {
    const jar = entry.jars[name]!;
    return {
      account: name,
      origin,
      cookies: jar.cookies.length,
      updatedAt: new Date(jar.updatedAt).toISOString(),
      active: entry.active === name,
    };
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

let browserJars: AccountJars | undefined;

/** The jars on the real browser: chrome.cookies for the session, chrome.storage.local for the jars. */
export function chromeAccountJars(): AccountJars {
  browserJars ??= new AccountJars({
    getAll: async () => (await chrome.cookies.getAll({})) as unknown as JarCookie[],
    set: (details) => chrome.cookies.set(details as unknown as chrome.cookies.SetDetails),
    remove: (details) => chrome.cookies.remove(details as unknown as chrome.cookies.CookieDetails),
    load: async () =>
      (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as AccountStoreData | undefined,
    save: (data) => chrome.storage.local.set({ [STORAGE_KEY]: data }),
  });
  return browserJars;
}
