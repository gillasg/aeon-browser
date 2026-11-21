import { createHmac } from "node:crypto";
import type { RoutineRecord, WebhookDelivery } from "@aeon/domain";

const ATTEMPTS = 3;
const BACKOFF_MS = [200, 800];

export interface WebhookDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** POST `{routineId, title, value, firedAt}` when a check passes. A secret signs the raw body. */
export async function deliverRoutineWebhook(
  routine: Pick<RoutineRecord, "routineId" | "title" | "webhook">,
  value: unknown,
  deps: WebhookDeps = {},
): Promise<WebhookDelivery | undefined> {
  const webhook = routine.webhook;
  if (!webhook?.url) return undefined;
  const body = JSON.stringify({
    routineId: routine.routineId,
    title: routine.title,
    value,
    firedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (webhook.secret) headers["X-Aeon-Signature"] = signWebhook(webhook.secret, body);
  return postUntilDelivered(webhook.url, headers, body, deps);
}

async function postUntilDelivered(
  url: string,
  headers: Record<string, string>,
  body: string,
  deps: WebhookDeps,
): Promise<WebhookDelivery> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? delay;
  let lastError = "delivery failed";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const posted = await postOnce(fetchImpl, url, headers, body);
    if (posted.delivered) return { status: "delivered", attempts: attempt };
    lastError = posted.error;
    if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 800);
  }
  return { status: "failed", attempts: ATTEMPTS, error: lastError };
}

const WEBHOOK_TIMEOUT_MS = 15_000;

async function postOnce(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ delivered: true } | { delivered: false; error: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (response.ok) return { delivered: true };
    return { delivered: false, error: `HTTP ${response.status}`.slice(0, 500) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery failed";
    return { delivered: false, error: message.slice(0, 500) };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
