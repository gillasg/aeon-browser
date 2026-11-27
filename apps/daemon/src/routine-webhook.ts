import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import { graftDataDirectory } from "@graft/location";
import type { RoutineRecord, WebhookDelivery } from "@graft/domain";
import { postPinned, resolveWebhook, type Resolve } from "./webhook-guard.js";
import {
  WebhookQueue,
  type Outcome,
  type QueueClock,
  type QueuedDelivery,
} from "./webhook-queue.js";

/** One try waits at most this long; the routine run never waits at all. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

export interface WebhookDeps {
  queue?: WebhookQueue;
  now?: () => Date;
}

export interface SendDeps {
  resolve?: Resolve;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Queues `{id, routineId, title, value, firedAt}` for a passing check and returns at once.
 * Delivery, retries and their outcome happen in the queue; a run never waits on a receiver.
 */
export async function deliverRoutineWebhook(
  routine: Pick<RoutineRecord, "routineId" | "title" | "webhook">,
  value: unknown,
  deps: WebhookDeps = {},
): Promise<WebhookDelivery | undefined> {
  const webhook = routine.webhook;
  if (!webhook?.url) return undefined;
  const id = randomUUID();
  const body = JSON.stringify({
    id,
    routineId: routine.routineId,
    title: routine.title,
    value,
    firedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  (deps.queue ?? sharedQueue()).add({ id, url: webhook.url, secret: webhook.secret ?? null, body });
  return undefined;
}

/** The headers one try carries: a fresh timestamp signed together with the body. */
export function webhookHeaders(
  item: Pick<QueuedDelivery, "id" | "secret" | "body">,
  unixSeconds: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Graft-Delivery": item.id,
  };
  if (item.secret) headers["X-Graft-Signature"] = signWebhook(item.secret, item.body, unixSeconds);
  return headers;
}

/** One try: resolve and check the address now, connect to exactly that address, never redirect. */
export async function sendWebhookOnce(item: QueuedDelivery, deps: SendDeps = {}): Promise<Outcome> {
  try {
    const pinned = await resolveWebhook(item.url, deps.resolve);
    const seconds = Math.floor((deps.now ?? Date.now)() / 1000);
    const result = await postPinned(
      pinned,
      webhookHeaders(item, seconds),
      item.body,
      deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
    );
    if (result.status >= 200 && result.status < 300) return { delivered: true };
    if (result.status >= 300 && result.status < 400)
      return {
        delivered: false,
        error: `HTTP ${result.status} redirect to ${result.location || "nowhere"} was not followed`,
      };
    return { delivered: false, error: `HTTP ${result.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery failed";
    return { delivered: false, error: message.slice(0, 500) };
  }
}

/** `t=<unix>,v1=<hex hmac of "t.body">`: a receiver rejects old `t` values and seen ids. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

let shared: WebhookQueue | undefined;

/** The daemon's queue, opened on first use; anything left from before a restart resumes. */
export function sharedQueue(clock?: QueueClock): WebhookQueue {
  shared ??= new WebhookQueue(
    join(graftDataDirectory(), "graft-webhooks.sqlite"),
    (item) => sendWebhookOnce(item),
    clock,
    (line) => console.error(`[graft] ${line}`),
  );
  return shared;
}
