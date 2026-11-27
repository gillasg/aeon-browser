import { assertNoSealedSecrets, REDACTED, scrubSecrets } from "@graft/protocol";
import { SealVault, siteOf } from "@browserkit/engine/native-browser-seal";
import { globToRegExp, whereHolds, type JsonWhere } from "@browserkit/engine/native-browser-wire";
import { armTap, disarmTap } from "@browserkit/engine/stealth";

// The graft/tap event family: live WebSocket, server-sent event and data-channel frames of one tab,
// pushed to an MCP client. Every subscription arms its tap in the stealth ledger and the last one
// to end disarms it. Frames are filtered here, before anything wakes the client, then sealed,
// scrubbed, capped and paced (one notification per window, a drop-oldest ring behind it).

type Json = Record<string, unknown>;
export const TAP_EVENT = "graft/tap";
export type TapKind = "ws" | "sse" | "webrtc";
export type TapDir = "in" | "out";
export const TAP_RING = 256;
export const TAP_PAYLOAD_MAX = 4096;
export const TAP_WINDOW_MS = 100;
const KINDS: TapKind[] = ["ws", "sse", "webrtc"];
const WRAPS: Record<TapKind, string[]> = {
  ws: [],
  sse: [],
  webrtc: [
    "RTCDataChannel.prototype.send",
    "RTCDataChannel.prototype.addEventListener",
    "RTCDataChannel.prototype.onmessage",
  ],
};
const SEALED = /graft-sealed:[a-z0-9]{12}/g;

/** One frame as the browser side reports it. */
export interface TapFrame {
  tab: number;
  kind: TapKind;
  dir: TapDir;
  url?: string;
  data: unknown;
  headers?: Record<string, string>;
  at?: number;
}

/** Where frames come from: installs and removes the in-page/debugger tap for one tab and kind.
 * `remove` restores the page's originals, and turns Runtime off when `runtimeInUse` is false. */
export interface TapSource {
  resolveTab(ref: number | undefined): Promise<number> | number;
  install(tab: number, kind: TapKind): Promise<void> | void;
  remove(tab: number, kind: TapKind, state: { runtimeInUse: boolean }): Promise<void> | void;
  onFrame(listener: (frame: TapFrame) => void): () => void;
}

interface TapFilter {
  tab: number;
  kinds: TapKind[];
  dir: TapDir | "both";
  match?: string;
  where?: JsonWhere;
}
interface TapSubscription {
  filter: TapFilter;
  ring: Json[];
  dropped: number;
  last: number;
  timer?: NodeJS.Timeout | undefined;
}

export const TAP_STREAM_INFO: Json = {
  name: TAP_EVENT,
  dynamic: true,
  description:
    "Live frames of one tab (WebSocket, server-sent events, WebRTC data channels). Filter by tab, kind, dir, match and where; at most 10 notifications a second, 4 KB each.",
  filterSchema: {
    type: "object",
    properties: {
      tab: { type: ["string", "integer"] },
      kind: { enum: ["ws", "sse", "webrtc", "all"] },
      match: { type: "string" },
      dir: { enum: ["in", "out", "both"] },
      where: { type: "object" },
    },
  },
  payloadSchema: {
    type: "object",
    properties: {
      tab: { type: "string" },
      kind: { type: "string" },
      dir: { type: "string" },
      url: { type: "string" },
      data: {},
      at: { type: "string", format: "date-time" },
      dropped: { type: "integer" },
      truncated: { type: "boolean" },
    },
    required: ["tab", "kind", "dir", "data", "at", "dropped"],
  },
};

export class TapStreams {
  private readonly subscriptions = new Map<string, TapSubscription>();
  private readonly armed = new Map<string, number>();
  private readonly vault = new SealVault();
  private off: (() => void) | undefined;

  constructor(
    private readonly source: TapSource | undefined,
    private readonly notify: (method: string, params: Json) => void,
  ) {}

  has(subscriptionId: string): boolean {
    return this.subscriptions.has(subscriptionId);
  }

  async subscribe(subscriptionId: string, raw: unknown): Promise<void> {
    const source = this.source;
    if (!source) throw new Error("graft/tap needs a connected browser: none is attached.");
    const filter = await readTapFilter(raw, source);
    const subscription: TapSubscription = { filter, ring: [], dropped: 0, last: 0 };
    this.subscriptions.set(subscriptionId, subscription);
    this.off ??= source.onFrame((frame) => this.hear(frame));
    try {
      for (const kind of filter.kinds) await this.arm(filter.tab, kind);
    } catch (error) {
      await this.end(subscriptionId);
      throw error;
    }
  }

  /** Ends one subscription; the last one on a tab and kind always disarms it. */
  async end(subscriptionId: string): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    this.subscriptions.delete(subscriptionId);
    clearTimeout(subscription.timer);
    const failures: unknown[] = [];
    for (const kind of subscription.filter.kinds)
      await this.disarm(subscription.filter.tab, kind).catch((error) => failures.push(error));
    if (!this.subscriptions.size) {
      this.off?.();
      this.off = undefined;
    }
    if (failures.length) throw failures[0];
    return true;
  }

  /** Client gone or hub closing: every tap disarms, every timer stops. */
  async close(): Promise<void> {
    for (const id of [...this.subscriptions.keys()]) await this.end(id).catch(() => undefined);
  }

  private async arm(tab: number, kind: TapKind): Promise<void> {
    const key = `${tab}:${kind}`;
    const count = this.armed.get(key) ?? 0;
    this.armed.set(key, count + 1);
    if (count) return;
    armTap(tab, { label: tapLabel(kind), world: "main", wraps: WRAPS[kind], runtime: true });
    await this.source?.install(tab, kind);
  }

  private async disarm(tab: number, kind: TapKind): Promise<void> {
    const key = `${tab}:${kind}`;
    const count = (this.armed.get(key) ?? 1) - 1;
    if (count > 0) {
      this.armed.set(key, count);
      return;
    }
    this.armed.delete(key);
    const state = disarmTap(tab, tapLabel(kind));
    await this.source?.remove(tab, kind, state);
  }

  private hear(frame: TapFrame): void {
    for (const [id, subscription] of this.subscriptions) {
      if (!frameMatches(subscription.filter, frame)) continue;
      subscription.ring.push(this.payload(frame));
      if (subscription.ring.length > TAP_RING) {
        subscription.ring.shift();
        subscription.dropped++;
      }
      this.schedule(id, subscription);
    }
  }

  private schedule(id: string, subscription: TapSubscription): void {
    if (subscription.timer || !subscription.ring.length) return;
    const wait = Math.max(0, subscription.last + TAP_WINDOW_MS - Date.now());
    subscription.timer = setTimeout(() => this.flush(id, subscription), wait);
    subscription.timer.unref();
  }

  private flush(id: string, subscription: TapSubscription): void {
    subscription.timer = undefined;
    if (!this.subscriptions.has(id)) return;
    const next = subscription.ring.shift();
    if (!next) return;
    subscription.last = Date.now();
    const payload = { ...next, dropped: subscription.dropped };
    subscription.dropped = 0;
    this.notify("notifications/events/emitted", {
      subscriptionId: id,
      name: TAP_EVENT,
      payload,
    });
    this.schedule(id, subscription);
  }

  private payload(frame: TapFrame): Json {
    const site = frame.url ? siteOf(frame.url) : null;
    const headers = frame.headers
      ? Object.fromEntries(
          Object.entries(frame.headers).map(([name, value]) => [
            name,
            this.vault.seal(String(value), site),
          ]),
        )
      : undefined;
    const { data, truncated } = capData(canary(scrubSecrets(frame.data)));
    return {
      tab: `t${frame.tab}`,
      kind: frame.kind,
      dir: frame.dir,
      ...(frame.url ? { url: canary(scrubSecrets(frame.url)) } : {}),
      ...(headers ? { headers } : {}),
      data,
      at: new Date(frame.at ?? Date.now()).toISOString(),
      ...(truncated ? { truncated: true } : {}),
    };
  }
}

const tapLabel = (kind: TapKind): string => `MCP live tap (${kind})`;

async function readTapFilter(raw: unknown, source: TapSource): Promise<TapFilter> {
  const value = (raw && typeof raw === "object" ? raw : {}) as Json;
  // Check the whole filter first: a bad one fails at once, before any browser round trip.
  const kind = readKind(value.kind);
  const dir = readDir(value.dir);
  const ref = tabRef(value.tab);
  const where = readWhere(value.where);
  const tab = await source.resolveTab(ref);
  return {
    tab,
    kinds: kind === "all" ? [...KINDS] : [kind],
    dir,
    ...(typeof value.match === "string" && value.match ? { match: value.match } : {}),
    ...(where ?? {}),
  };
}

function readKind(value: unknown): TapKind | "all" {
  const kind = value ?? "all";
  if (kind === "all" || KINDS.includes(kind as TapKind)) return kind as TapKind | "all";
  throw new Error(`Unknown tap kind ${String(kind)}`);
}

function readDir(value: unknown): TapFilter["dir"] {
  const dir = value ?? "both";
  if (dir === "in" || dir === "out" || dir === "both") return dir;
  throw new Error(`Unknown tap dir ${String(dir)}`);
}

function tabRef(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  const id = Number(/^t\d+$/i.test(text) ? text.slice(1) : text);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid tab ${text}`);
  return id;
}

function readWhere(value: unknown): { where: JsonWhere } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || typeof (value as Json).key !== "string")
    throw new Error("where needs a key");
  return { where: value as JsonWhere };
}

function frameMatches(filter: TapFilter, frame: TapFrame): boolean {
  if (frame.tab !== filter.tab || !filter.kinds.includes(frame.kind)) return false;
  if (filter.dir !== "both" && frame.dir !== filter.dir) return false;
  const text = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data ?? null);
  if (filter.match && !textMatches(filter.match, frame.url ?? "", text)) return false;
  return !filter.where || whereHolds(parsed(frame.data), filter.where);
}

function textMatches(match: string, url: string, text: string): boolean {
  if (/[*?]/.test(match)) return globToRegExp(match).test(url);
  return url.includes(match) || text.includes(match);
}

function parsed(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

/** Egress canary: no sealed handle or raw credential leaves in a frame body. */
function canary<T>(value: T): T {
  try {
    assertNoSealedSecrets(value, TAP_EVENT);
    return value;
  } catch {
    return redactDeep(value);
  }
}

function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") {
    try {
      assertNoSealedSecrets(value.replace(SEALED, REDACTED), TAP_EVENT);
      return value.replace(SEALED, REDACTED) as T;
    } catch {
      return REDACTED as T;
    }
  }
  if (!value || typeof value !== "object" || depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value as Json).map(([key, item]) => [key, redactDeep(item, depth + 1)]),
  ) as T;
}

function capData(data: unknown): { data: unknown; truncated: boolean } {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  if (Buffer.byteLength(text) <= TAP_PAYLOAD_MAX) return { data, truncated: false };
  let cut = Buffer.from(text).subarray(0, TAP_PAYLOAD_MAX).toString("utf8");
  while (Buffer.byteLength(cut) > TAP_PAYLOAD_MAX) cut = cut.slice(0, -1);
  return { data: cut, truncated: true };
}
