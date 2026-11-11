// Failed requests grouped by endpoint, for page.network.failures().

import type { NetworkEntry } from "./native-browser-network-format.js";

export function failuresOf(
  entries: readonly NetworkEntry[],
  match = "",
): Array<Record<string, unknown>> {
  const groups = new Map<string, FailureGroup>();
  for (const entry of entries) {
    if (!entry.done || entry.status === undefined) continue;
    if (match && !entry.url.includes(match)) continue;
    const key = endpointOf(entry);
    const group = groups.get(key) ?? emptyGroup(entry);
    if (entry.status >= 400 || entry.status === 0) group.failures.push(entry);
    else if (!group.success || entry.startedAt > group.success.startedAt) group.success = entry;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.failures.length)
    .sort((left, right) => right.failures.length - left.failures.length)
    .slice(0, 20)
    .map(failureGroup);
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

interface FailureGroup {
  method: string;
  path: string;
  failures: NetworkEntry[];
  success: NetworkEntry | undefined;
}

function emptyGroup(entry: NetworkEntry): FailureGroup {
  return { method: entry.method, path: pathOf(entry.url), failures: [], success: undefined };
}

function endpointOf(entry: NetworkEntry): string {
  return entry.method + " " + pathOf(entry.url);
}

function failureGroup(group: FailureGroup): Record<string, unknown> {
  const last = group.failures[group.failures.length - 1];
  return {
    method: group.method,
    path: group.path,
    attempts: group.failures.length,
    statuses: [...new Set(group.failures.map((entry) => entry.status))],
    last: last ? failureOf(last) : null,
    lastSuccess: group.success ? sizeOf(group.success) : null,
  };
}

function failureOf(entry: NetworkEntry): Record<string, unknown> {
  return {
    status: entry.status ?? 0,
    ...(entry.statusText ? { statusText: entry.statusText } : {}),
    requestBytes: requestBytesOf(entry),
    responseBytes: sizeOf(entry).responseBytes,
    durationMs: entry.durationMs ?? null,
    ...blockHeaders(entry.responseHeaders),
    ...(entry.failed ? { failed: entry.failed } : {}),
    ...(entry.body ? { body: entry.body.slice(0, 500) } : {}),
  };
}

function sizeOf(entry: NetworkEntry): {
  status: number;
  requestBytes: number;
  responseBytes: number;
} {
  return {
    status: entry.status ?? 0,
    requestBytes: requestBytesOf(entry),
    responseBytes: entry.bodyBytes ?? entry.size ?? entry.body?.length ?? 0,
  };
}

/** CDP returns binary post data base64-encoded; text bodies are plain. Estimate the real bytes. */
function requestBytesOf(entry: NetworkEntry): number {
  const body = entry.requestBody ?? "";
  if (!body) return 0;
  if (body.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(body)) return base64Bytes(body);
  return body.length;
}

function base64Bytes(body: string): number {
  const clean = body.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** The headers that name a CDN/WAF or a rate limit, without dumping every header. */
function blockHeaders(headers: Record<string, string> | undefined): Record<string, unknown> {
  const wanted =
    /^(server|via|x-cache|retry-after|akamai-grn|cf-ray|x-akamai-|x-ratelimit-|x-amzn-|x-served-by)/i;
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (wanted.test(name)) found[name.toLowerCase()] = String(value).slice(0, 200);
  }
  return Object.keys(found).length ? { headers: found } : {};
}
