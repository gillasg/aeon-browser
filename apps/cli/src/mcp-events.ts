import { randomUUID } from "node:crypto";
import { readEventLog, type GraftEventKind, type GraftEventRecord } from "@graft/location";
import { scrubSecrets } from "@graft/protocol";
import { TAP_EVENT, TAP_STREAM_INFO, TapStreams, type TapSource } from "./mcp-tap-stream.js";

// MCP Events (io.modelcontextprotocol/events): routine firings as subscribable streams. A
// subscriber polls with a cursor, or is pushed notifications/events/emitted while connected.
// Cursors are the event log's own monotonic integers, so a client resumes after a restart.

type Json = Record<string, unknown>;
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
const ALL = "graft/routine.fired";
const STREAMS: { name: string; kind?: GraftEventKind; description: string }[] = [
  { name: ALL, description: "Any routine whose check passed: watcher, listener or webhook." },
  {
    name: "graft/watcher.fired",
    kind: "watcher",
    description: "A scheduled watcher's check passed.",
  },
  {
    name: "graft/listener.fired",
    kind: "listener",
    description: "A response-listener routine heard a matching response.",
  },
  {
    name: "graft/webhook.fired",
    kind: "webhook",
    description: "A routine with a webhook trigger fired (the POST is sent as well).",
  },
];
const PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    routineId: { type: "string" },
    site: { type: "string" },
    title: { type: "string" },
    value: {},
    firedAt: { type: "string", format: "date-time" },
    cursor: { type: "string" },
  },
  required: ["routineId", "site", "title", "value", "firedAt", "cursor"],
};

interface Filter {
  routineId?: string;
  site?: string;
}
interface Subscription {
  name: string;
  filter: Filter;
  cursor: number;
}

export interface EventHubOptions {
  dataDirectory: string;
  notify: (method: string, params: Json) => void;
  pollMs?: number;
  /** Live frames for the graft/tap family; without one, subscribing to it fails. */
  tap?: TapSource;
}

export class EventHub {
  private readonly subscriptions = new Map<string, Subscription>();
  private timer: NodeJS.Timeout | undefined;
  private pushing = false;
  private readonly taps: TapStreams;

  constructor(private readonly options: EventHubOptions) {
    this.taps = new TapStreams(options.tap, options.notify);
  }

  list(): Json {
    return {
      events: STREAMS.map((stream) => ({
        name: stream.name,
        description: stream.description,
        payloadSchema: PAYLOAD_SCHEMA,
      })).concat([TAP_STREAM_INFO as never]),
    };
  }

  async subscribe(params: Json): Promise<Json> {
    if (params.name === TAP_EVENT) {
      const subscriptionId = randomUUID();
      await this.taps.subscribe(subscriptionId, params.filter);
      return { subscriptionId, name: TAP_EVENT, cursor: "0" };
    }
    const name = streamName(params.name);
    const filter = readFilter(params.filter);
    const cursor = params.cursor === undefined ? await this.latest() : parseCursor(params.cursor);
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, { name, filter, cursor });
    this.startPushing();
    return { subscriptionId, name, cursor: String(cursor) };
  }

  async unsubscribe(params: Json): Promise<Json> {
    const id = String(params.subscriptionId ?? "");
    if (this.taps.has(id)) return { unsubscribed: await this.taps.end(id) };
    const removed = this.subscriptions.delete(String(params.subscriptionId ?? ""));
    if (!this.subscriptions.size) this.stop();
    return { unsubscribed: removed };
  }

  /** By subscription (its cursor advances) or statelessly by stream name and cursor. */
  async poll(params: Json): Promise<Json> {
    const limit = Math.min(Math.max(Number(params.limit ?? 100) || 100, 1), 1000);
    const subscription = this.subscriptionFor(params);
    const query = subscription ?? {
      name: streamName(params.name),
      filter: readFilter(params.filter),
      cursor: parseCursor(params.cursor ?? "0"),
    };
    const after = params.cursor === undefined ? query.cursor : parseCursor(params.cursor);
    const matched = (await this.read()).filter(
      (record) => record.cursor > after && matches(query, record),
    );
    const page = matched.slice(0, limit);
    const cursor = page.at(-1)?.cursor ?? Math.max(after, subscription ? query.cursor : after);
    if (subscription) subscription.cursor = cursor;
    return {
      events: page.map((record) => toEvent(query.name, record)),
      cursor: String(cursor),
      hasMore: matched.length > page.length,
    };
  }

  private subscriptionFor(params: Json): Subscription | undefined {
    if (typeof params.subscriptionId !== "string") return undefined;
    if (this.taps.has(params.subscriptionId)) throw new Error("graft/tap is push-only: no poll");
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) throw new Error(`Unknown subscriptionId ${params.subscriptionId}`);
    return subscription;
  }

  /** The client is gone: polling stops and every live tap disarms. */
  async close(): Promise<void> {
    this.stop();
    await this.taps.close();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private startPushing(): void {
    if (this.timer) return;
    const ms = this.options.pollMs ?? 1000;
    this.timer = setInterval(() => void this.push(), ms);
    this.timer.unref();
  }

  private async push(): Promise<void> {
    if (this.pushing) return;
    this.pushing = true;
    try {
      const records = await this.read();
      for (const [subscriptionId, subscription] of this.subscriptions)
        for (const record of records) {
          if (record.cursor <= subscription.cursor) continue;
          subscription.cursor = record.cursor;
          if (matches(subscription, record))
            this.options.notify("notifications/events/emitted", {
              subscriptionId,
              ...toEvent(subscription.name, record),
            });
        }
    } finally {
      this.pushing = false;
    }
  }

  private async latest(): Promise<number> {
    return (await this.read()).at(-1)?.cursor ?? 0;
  }

  private read(): Promise<GraftEventRecord[]> {
    return readEventLog(this.options.dataDirectory);
  }
}

/** The next event after `cursor` on a stream; resolves undefined when aborted. */
export async function nextEvent(
  hub: EventHub,
  params: Json,
  signal: AbortSignal,
  pollMs = 250,
): Promise<Json | undefined> {
  let cursor = String(params.cursor ?? "0");
  while (!signal.aborted) {
    const page = await hub.poll({ name: params.name, filter: params.filter, cursor, limit: 1 });
    const [event] = page.events as Json[];
    if (event) return event;
    cursor = String(page.cursor);
    await new Promise((done) => setTimeout(done, pollMs));
  }
  return undefined;
}

function toEvent(name: string, record: GraftEventRecord): Json {
  const cursor = String(record.cursor);
  return {
    name,
    cursor,
    data: scrubSecrets({
      routineId: record.routineId,
      site: record.site,
      title: record.title,
      value: record.value,
      firedAt: record.firedAt,
      cursor,
    }),
  };
}

function matches(query: Subscription, record: GraftEventRecord): boolean {
  const kind = STREAMS.find((stream) => stream.name === query.name)?.kind;
  if (kind && record.kind !== kind) return false;
  if (query.filter.routineId && record.routineId !== query.filter.routineId) return false;
  return !query.filter.site || record.site === query.filter.site;
}

function streamName(value: unknown): string {
  const name = value === undefined ? ALL : String(value);
  if (!STREAMS.some((stream) => stream.name === name)) throw new Error(`Unknown event ${name}`);
  return name;
}

function readFilter(value: unknown): Filter {
  if (!value || typeof value !== "object") return {};
  const { routineId, site } = value as Json;
  return {
    ...(typeof routineId === "string" ? { routineId } : {}),
    ...(typeof site === "string" ? { site } : {}),
  };
}

function parseCursor(value: unknown): number {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid cursor");
  return cursor;
}
