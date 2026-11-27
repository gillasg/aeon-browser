import { inferEffect, type CallEffect, type RoutineWebhook } from "@graft/domain";

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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("webhook url must be an http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("webhook url must be an http(s) URL.");
  if (isBlockedWebhookHost(parsed.hostname))
    throw new Error(
      "webhook url must target a public host, not a local or private network address.",
    );
  return url;
}

function isBlockedWebhookHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  if (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  )
    return true;
  if (host.startsWith("::ffff:")) return isBlockedIpv4(host.slice(7));
  return isBlockedIpv4(host);
}

const BLOCKED_IPV4_FIRST_OCTETS = new Set([0, 10, 127]);

function isBlockedIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (BLOCKED_IPV4_FIRST_OCTETS.has(a)) return true;
  return (
    (a === 169 && b === 254) ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
