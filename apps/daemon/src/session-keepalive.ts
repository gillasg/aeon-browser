// Zero-model session keepalive: a plain HTTP check per registered signed-in site, on a timer.
// A 401/403, a redirect to a sign-in page or a signed-out marker in the body marks the session
// expired and raises one "reauth-needed" event, so routines on that site stop cleanly instead of
// failing one by one. Failing checks back off; a healthy answer resets the backoff. No model is
// ever called, and no cookie or header value appears in an event or a status.

import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir } from "@graft/location";

export type SessionHealth = "healthy" | "expiring" | "expired" | "unknown";

export interface KeepaliveSite {
  id: string;
  /** A cheap signed-in page or API (an account endpoint), fetched with GET. */
  url: string;
  intervalMs?: number;
  /** Text that only a signed-out page shows ("Sign in", "Log in to continue"). */
  signedOutMarkers?: string[];
  /** Path pieces of the site's sign-in page; a redirect there means signed out. */
  loginPaths?: string[];
  /** Epoch ms the session cookie expires, when known; within expiringWithinMs it is "expiring". */
  expiresAt?: number;
}

export interface KeepaliveStatus {
  id: string;
  origin: string;
  health: SessionHealth;
  lastCheckedAt?: string;
  lastStatus?: number;
  reason?: string;
  failures: number;
  nextCheckInMs?: number;
}

export interface KeepaliveEvent {
  type: "reauth-needed" | "recovered" | "expiring";
  id: string;
  origin: string;
  reason: string;
}

export interface KeepaliveDeps {
  fetch?: typeof fetch;
  /** Session headers for a site (its Cookie header), supplied by the browser bridge when it can. */
  headers?: (site: KeepaliveSite) => Promise<Record<string, string> | undefined>;
  onEvent?: (event: KeepaliveEvent) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  defaultIntervalMs?: number;
  maxBackoffMs?: number;
  expiringWithinMs?: number;
  timeoutMs?: number;
}

interface Entry {
  site: KeepaliveSite;
  status: KeepaliveStatus;
  timer?: unknown;
  running: boolean;
}

const DEFAULT_LOGIN_PATHS = ["/login", "/signin", "/sign-in", "/sign_in", "/auth", "/session/new"];
const DEFAULT_MARKERS = ['type="password"', "type='password'"];

/** Decides health from one answer: status, final URL and body. Pure, so it is tested directly. */
export function judgeSession(
  site: KeepaliveSite,
  answer: { status: number; url: string; location?: string | undefined; body: string },
): { health: SessionHealth; reason: string } {
  if (answer.status === 401 || answer.status === 403)
    return { health: "expired", reason: `HTTP ${answer.status}` };
  const paths = (site.loginPaths ?? DEFAULT_LOGIN_PATHS).map((path) => path.toLowerCase());
  const own = pathOf(site.url, site.url);
  const landed = [answer.url, answer.location ?? ""]
    .map((url) => pathOf(url, site.url))
    .filter((path) => path && path !== own);
  if (landed.some((path) => paths.some((login) => path.startsWith(login))))
    return { health: "expired", reason: "redirected to sign-in" };
  const body = answer.body.toLowerCase();
  const marker = [...(site.signedOutMarkers ?? []), ...DEFAULT_MARKERS].find((text) =>
    body.includes(text.toLowerCase()),
  );
  if (marker) return { health: "expired", reason: "signed-out page" };
  if (answer.status >= 500) return { health: "unknown", reason: `HTTP ${answer.status}` };
  return { health: "healthy", reason: `HTTP ${answer.status}` };
}

function pathOf(url: string, base: string): string {
  if (!url) return "";
  try {
    return new URL(url, base).pathname.toLowerCase();
  } catch {
    return "";
  }
}

export class SessionKeepalive {
  readonly #deps: KeepaliveDeps;
  readonly #entries = new Map<string, Entry>();
  #stopped = false;

  constructor(deps: KeepaliveDeps = {}) {
    this.#deps = deps;
  }

  register(site: KeepaliveSite): KeepaliveStatus {
    const origin = new URL(site.url).origin;
    this.unregister(site.id);
    const entry: Entry = {
      site,
      running: false,
      status: { id: site.id, origin, health: "unknown", failures: 0 },
    };
    this.#entries.set(site.id, entry);
    if (!this.#stopped) this.#schedule(entry, 0);
    return { ...entry.status };
  }

  unregister(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#clear(entry);
    return this.#entries.delete(id);
  }

  list(): KeepaliveStatus[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.status }));
  }

  /** Checks one site now (also what the timer runs). */
  async check(id: string): Promise<KeepaliveStatus | undefined> {
    const entry = this.#entries.get(id);
    if (!entry || entry.running) return entry && { ...entry.status };
    entry.running = true;
    try {
      const verdict = await this.#probe(entry.site);
      this.#apply(entry, verdict);
    } finally {
      entry.running = false;
    }
    if (!this.#stopped && this.#entries.get(id) === entry)
      this.#schedule(entry, this.#delay(entry));
    return { ...entry.status };
  }

  stop(): void {
    this.#stopped = true;
    for (const entry of this.#entries.values()) this.#clear(entry);
  }

  async #probe(site: KeepaliveSite) {
    const doFetch = this.#deps.fetch ?? fetch;
    try {
      const headers = (await this.#deps.headers?.(site)) ?? {};
      const response = await doFetch(site.url, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(this.#deps.timeoutMs ?? 15000),
      });
      const body = response.status < 300 ? (await response.text()).slice(0, 200_000) : "";
      const verdict = judgeSession(site, {
        status: response.status,
        url: response.url || site.url,
        location: response.headers.get("location") ?? undefined,
        body,
      });
      return { ...verdict, status: response.status };
    } catch (error) {
      return { health: "unknown" as const, reason: `unreachable: ${(error as Error).name}` };
    }
  }

  #apply(entry: Entry, verdict: { health: SessionHealth; reason: string; status?: number }) {
    const before = entry.status.health;
    let health = verdict.health;
    const within = this.#deps.expiringWithinMs ?? 24 * 3600_000;
    if (health === "healthy" && entry.site.expiresAt && entry.site.expiresAt - this.#now() < within)
      health = "expiring";
    entry.status = {
      ...entry.status,
      health: health === "unknown" && before !== "unknown" ? before : health,
      lastCheckedAt: new Date(this.#now()).toISOString(),
      reason: verdict.reason,
      failures: health === "healthy" || health === "expiring" ? 0 : entry.status.failures + 1,
      ...(verdict.status === undefined ? {} : { lastStatus: verdict.status }),
    };
    this.#announce(entry, before, entry.status.health);
  }

  #announce(entry: Entry, before: SessionHealth, after: SessionHealth) {
    if (before === after) return;
    const base = {
      id: entry.site.id,
      origin: entry.status.origin,
      reason: entry.status.reason ?? "",
    };
    if (after === "expired") this.#deps.onEvent?.({ type: "reauth-needed", ...base });
    else if (after === "expiring") this.#deps.onEvent?.({ type: "expiring", ...base });
    else if (after === "healthy" && before === "expired")
      this.#deps.onEvent?.({ type: "recovered", ...base });
  }

  /** The normal interval while healthy; doubling (to the cap) while expired or unreachable. */
  #delay(entry: Entry): number {
    const interval = entry.site.intervalMs ?? this.#deps.defaultIntervalMs ?? 15 * 60_000;
    const failures = entry.status.failures;
    if (!failures) return interval;
    return Math.min(
      interval * 2 ** Math.min(failures, 10),
      this.#deps.maxBackoffMs ?? 6 * 3600_000,
    );
  }

  #schedule(entry: Entry, ms: number) {
    this.#clear(entry);
    const set =
      this.#deps.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay).unref());
    entry.status.nextCheckInMs = ms;
    entry.timer = set(() => void this.check(entry.site.id), ms);
  }

  #clear(entry: Entry) {
    if (entry.timer === undefined) return;
    (this.#deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(entry.timer);
    entry.timer = undefined;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

/** The registered sites, kept in a private file (0600 in a 0700 directory) in the data directory. */
export async function readKeepaliveSites(directory: string): Promise<KeepaliveSite[]> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, "session-keepalive.json"), "utf8"));
    return Array.isArray(parsed?.sites)
      ? parsed.sites.filter((site: KeepaliveSite) => site?.id && site?.url)
      : [];
  } catch {
    return [];
  }
}

export async function writeKeepaliveSites(
  directory: string,
  sites: KeepaliveSite[],
): Promise<void> {
  await ensurePrivateDir(directory);
  const path = join(directory, "session-keepalive.json");
  await writeFile(`${path}.tmp`, JSON.stringify({ sites }, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** Starts the keepalive for the sites registered in the data directory; stop() on shutdown. */
export async function startSessionKeepalive(
  directory: string,
  deps: KeepaliveDeps = {},
): Promise<SessionKeepalive> {
  const keepalive = new SessionKeepalive({
    onEvent: (event) =>
      process.stderr.write(`[auth] ${event.type} ${event.origin} (${event.reason})\n`),
    ...deps,
  });
  for (const site of await readKeepaliveSites(directory)) keepalive.register(site);
  return keepalive;
}
