// Words and hosts both the capture side (the engine) and learning (site-mapper) read the same
// way. One source, so a request the recorder calls a read or noise is learned the same.

/**
 * A path segment naming a read, token-bounded so `discover_web`, `search-v2` and `feed` match
 * (Bandcamp's POST /api/discover/1/discover_web is a filtered read).
 */
export const READ_SEGMENT =
  /(^|[-_])(search|discover|list|query|feed|browse|filter|lookup|suggest|autocomplete|find|fetch)([-_]|$)/i;

/** A token in a segment that changes state: `collection_add`, `item-delete`. */
export const WRITE_TOKEN =
  /(^|[-_])(add|delete|remove|create|update|edit|save|send|submit|post|buy|pay|purchase|checkout|follow|unfollow|like|unlike|vote|subscribe|unsubscribe|cancel)([-_]|$)/i;

/** True for a segment that names a read and no write. */
export function readSegment(segment: string): boolean {
  return READ_SEGMENT.test(segment) && !WRITE_TOKEN.test(segment);
}

/**
 * Ad, consent, telemetry and WAF hosts that leaked into learned models: never a site's own API.
 * Matched as the host or any subdomain of it.
 */
export const NOISE_HOSTS: readonly string[] = [
  "awswaf.com",
  "id5-sync.com",
  "alb.reddit.com",
  "pixel-config.reddit.com",
  "m.stripe.network",
  "r.stripe.com",
  "fundingchoicesmessages.google.com",
  "otel.cloud.redhat.com",
  "otlp.nr-data.net",
];

/** OpenTelemetry collectors: `otel.`, `otel-collector.`, `otlp.` hosts. */
const OTEL_HOST = /^(otel|otlp|otel-collector|opentelemetry)([.-]|$)/i;

/** True for a noise host (see NOISE_HOSTS) or an OpenTelemetry collector. */
export function isNoiseHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (OTEL_HOST.test(lower)) return true;
  return NOISE_HOSTS.some((name) => lower === name || lower.endsWith(`.${name}`));
}
