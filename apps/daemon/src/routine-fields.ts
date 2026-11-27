import { inferEffect, type CallEffect, type RoutineWebhook } from "@graft/domain";
import {
  resolveWebhook,
  UnresolvedWebhookHost,
  webhookUrlRefusal,
  type Resolve,
} from "./webhook-guard.js";

/** Omitted stays undefined. Anything else must be read, write or irreversible. */
export function parseEffect(value: unknown): CallEffect | undefined {
  if (value === undefined) return undefined;
  if (value !== "read" && value !== "write" && value !== "irreversible")
    throw new Error("effect must be read, write or irreversible.");
  return value;
}

/**
 * A webhook URL, or `{url, secret?}`. `undefined` keeps `fallback` (null on create).
 * `null` removes it. `secret` replaces the object's secret when it is its own argument.
 */
export function parseWebhook(
  value: unknown,
  secret: unknown,
  fallback: RoutineWebhook | null = null,
): RoutineWebhook | null {
  if (value === undefined && secret === undefined) return fallback;
  if (value === null) return null;
  if (value === undefined) {
    if (!fallback?.url) throw new Error("webhook url is required.");
    const next = secretText(secret);
    return next ? { url: fallback.url, secret: next } : { url: fallback.url };
  }
  const url = typeof value === "string" ? value.trim() : urlOf(value);
  const parsed = secretText(secret) ?? secretOf(value);
  return { url: assertWebhookUrl(url), ...(parsed ? { secret: parsed } : {}) };
}

/** Inferred when `override` is omitted. Irreversible words win; webhook-only defaults to read. */
export function inferRoutineEffect(input: {
  title: string;
  instruction: string;
  check: string | null;
  webhookOnly: boolean;
  override?: unknown;
}): CallEffect {
  return inferEffect({
    override: input.override,
    text: [input.title, input.instruction, input.check ?? ""].join("\n"),
    fallback: input.webhookOnly ? "read" : "write",
  });
}

export function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function urlOf(value: unknown): string {
  if (!value || typeof value !== "object" || typeof (value as { url?: unknown }).url !== "string")
    throw new Error("webhook must be an http(s) URL or {url, secret?}.");
  return (value as { url: string }).url.trim();
}

function secretOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return secretText((value as { secret?: unknown }).secret);
}

function secretText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 200)
    throw new Error("webhook secret must be a string of at most 200 characters.");
  return value;
}

function assertWebhookUrl(url: string): string {
  if (!url || url.length > 2000)
    throw new Error("webhook url must be an http(s) URL of at most 2000 characters.");
  const refused = webhookUrlRefusal(url);
  if (refused) throw new Error(refused);
  return url;
}

/**
 * The create-time half of the send-time check: resolves a webhook's host and refuses it when any
 * address is private. Run before parseWebhook wherever a webhook is set.
 */
export async function assertWebhookResolves(value: unknown, resolve?: Resolve): Promise<void> {
  if (value === undefined || value === null) return;
  const url = typeof value === "string" ? value.trim() : urlOf(value);
  await resolveWebhook(assertWebhookUrl(url), resolve).catch((error: unknown) => {
    if (!(error instanceof UnresolvedWebhookHost)) throw error;
  });
}
