// page.network.body(id, {decode | as}) and page.network.get(id): the recorded bytes, decoded.
import type { NetworkEntry } from "./native-browser-network-format.js";
import { bodyPreview } from "./native-browser-network-wait.js";
import {
  decodeRequestPayload,
  decodeWireBytes,
  fromBase64,
  type DecodeMode,
} from "./wire-decode.js";

const MODES = new Set(["auto", "json", "protobuf", "jspb", "rsc", "json-seq", "text", "bytes"]);
/** The same bound browser.fetch({as: 'base64'}) uses. */
const MAX_BINARY = 16_000_000;

/** The body decoded along the wire ladder, or as bounded raw base64. */
export function wireBodyOf(entry: NetworkEntry, options: Record<string, unknown>): unknown {
  const bytes = bytesOf(entry);
  const mime = entry.mimeType ?? entry.responseHeaders?.["content-type"] ?? "";
  if (!bytes)
    return { unavailable: true, reason: entry.bodyDropped ? "dropped to save memory" : "no body" };
  const truncated = entry.bodyTruncated === true || bytes.byteLength < (entry.size ?? 0);
  if (options.as === "base64") {
    if (bytes.byteLength > MAX_BINARY) return { truncated: true, bytes: bytes.byteLength, mime };
    return { base64: base64Of(entry, bytes), bytes: bytes.byteLength, mime, truncated };
  }
  const mode = String(options.decode ?? "auto");
  if (!MODES.has(mode)) throw new Error("decode must be one of: " + [...MODES].join(", "));
  const result = decodeWireBytes(bytes, { mime, url: entry.url, mode: mode as DecodeMode });
  return { ...result, truncated: result.truncated || truncated };
}

function bytesOf(entry: NetworkEntry): Uint8Array | undefined {
  if (entry.rawBody !== undefined) return fromBase64(entry.rawBody);
  if (entry.body !== undefined) return new TextEncoder().encode(entry.body);
  return undefined;
}

function base64Of(entry: NetworkEntry, bytes: Uint8Array): string {
  if (entry.rawBody !== undefined) return entry.rawBody;
  return decodeWireBytes(bytes, { mode: "bytes" }).value as string;
}

/** The full recorded request, with what its query or body carried decoded when it is binary. */
export function detailOf(entry: NetworkEntry): Record<string, unknown> {
  const { rawBody: _raw, ...detail } = entry;
  const decoded = decodeRequestPayload({
    url: entry.url,
    body: entry.requestBody,
    contentType: headerOf(entry.requestHeaders, "content-type"),
  });
  return decoded ? { ...detail, request: { decoded } } : detail;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const hit = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === name);
  return hit ? headers[hit] : undefined;
}

/** The default body: parsed JSON when it parses, else the text. */
export function textBodyOf(entry: NetworkEntry & { body: string }): unknown {
  if (!entry.bodyTruncated) {
    try {
      return JSON.parse(entry.body) as unknown;
    } catch {
      // Not JSON: return the text.
    }
  }
  return {
    text: entry.body,
    ...(entry.bodyTruncated ? { truncated: true, length: entry.bodyBytes } : {}),
  };
}

/** Response headers, capped: enough to read a content type or a block header. */
export function responseHeadersOf(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const all = Object.entries(headers ?? {});
  const kept = Object.fromEntries(
    all.slice(0, 40).map(([name, value]) => [name.toLowerCase(), String(value).slice(0, 500)]),
  );
  return all.length > 40 ? { ...kept, "x-headers-not-shown": String(all.length - 40) } : kept;
}

/** What page.network.waitFor resolves with. */
export function waitedEntry(entry: NetworkEntry): Record<string, unknown> {
  return {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    type: entry.type,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.statusText ? { statusText: entry.statusText } : {}),
    ...(entry.failed ? { failed: entry.failed } : {}),
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    headers: responseHeadersOf(entry.responseHeaders),
    body: bodyPreview(entry),
  };
}
