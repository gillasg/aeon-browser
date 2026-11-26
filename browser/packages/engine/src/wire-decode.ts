// Decodes recorded wire bodies (JSON, JSPB, React Server Component flight, framed JSON streams,
// schemaless protobuf) into plain values. Pure: no CDP, no DOM. Every walk is bounded, and
// malformed input falls through to text or base64 instead of throwing.

export type WireFormat = "json" | "protobuf" | "jspb" | "rsc" | "json-seq" | "text" | "bytes";
export type DecodeMode = "auto" | WireFormat;
export interface WireDecodeResult {
  format: WireFormat;
  value: unknown;
  bytes: number;
  truncated: boolean;
}
export interface ProtobufField {
  field: number;
  wire: "varint" | "fixed64" | "bytes" | "string" | "message" | "fixed32";
  value?: string | number;
  children?: ProtobufField[];
}
export interface WireHints {
  mime?: string | undefined;
  url?: string | undefined;
  mode?: DecodeMode | undefined;
}

const MAX_INPUT = 4_000_000;
const MAX_DEPTH = 8;
const MAX_NODES = 2000;
const MAX_ITEMS = 2000;
const MAX_LEAF_TEXT = 4000;
const MAX_LEAF_BASE64 = 4000;
const MAX_FALLBACK_BASE64 = 1_000_000;
const XSSI = /^\s*\)\]\}'[^\n]*\n?/;

/** Decodes raw bytes along the ladder, or with the one decoder `mode` names. */
export function decodeWireBytes(input: Uint8Array, hints: WireHints = {}): WireDecodeResult {
  const total = input.byteLength;
  const clipped = total > MAX_INPUT;
  const bytes = clipped ? input.subarray(0, MAX_INPUT) : input;
  const text = utf8(bytes);
  const result = ladder(bytes, text, hints);
  return { ...result, bytes: total, truncated: result.truncated || clipped };
}

/** The same ladder for a body that arrived as text. */
export function decodeWireText(text: string, hints: WireHints = {}): WireDecodeResult {
  return decodeWireBytes(new TextEncoder().encode(text), hints);
}

function ladder(
  bytes: Uint8Array,
  text: string | undefined,
  hints: WireHints,
): { format: WireFormat; value: unknown; truncated: boolean } {
  const mode = hints.mode ?? "auto";
  const mime = (hints.mime ?? "").toLowerCase();
  const url = hints.url ?? "";
  const tries: WireFormat[] =
    mode !== "auto"
      ? [mode]
      : [
          ...(/json\+protobuf|jspb/.test(mime) ? (["jspb"] as const) : []),
          "json",
          ...(/x-component/.test(mime) || /[?&]_rsc=/.test(url) ? (["rsc"] as const) : []),
          "json-seq",
          ...(text === undefined || /protobuf|octet-stream|grpc/.test(mime)
            ? (["protobuf"] as const)
            : []),
        ];
  for (const format of tries) {
    const hit = attempt(format, bytes, text);
    if (hit) return { format, ...hit };
  }
  if (text !== undefined && printable(text))
    return { format: "text", value: text, truncated: false };
  const base64 = toBase64(bytes.subarray(0, (MAX_FALLBACK_BASE64 / 4) * 3));
  return { format: "bytes", value: base64, truncated: base64.length * 0.75 < bytes.byteLength };
}

function attempt(
  format: WireFormat,
  bytes: Uint8Array,
  text: string | undefined,
): { value: unknown; truncated: boolean } | undefined {
  if (format === "protobuf") return decodeProtobuf(bytes);
  if (format === "bytes") return { value: toBase64(bytes), truncated: false };
  if (text === undefined) return undefined;
  if (format === "text") return { value: text, truncated: false };
  if (format === "json") return jsonValue(text);
  if (format === "jspb") return decodeJspb(text);
  if (format === "rsc") return decodeRscFlight(text);
  return decodeJsonSeq(text);
}

/** A body is JSON when its first non-space character opens a value and the whole text parses. */
function jsonValue(text: string): { value: unknown; truncated: boolean } | undefined {
  const body = text.replace(XSSI, "");
  if (!/^\s*[[{]/.test(body)) return undefined;
  const value = parse(body);
  return value === undefined ? undefined : { value, truncated: false };
}

/** JSPB (`application/json+protobuf`): a JSON array, often behind the `)]}'` XSSI guard. */
export function decodeJspb(text: string): { value: unknown; truncated: boolean } | undefined {
  return jsonValue(text);
}

/** React Server Component flight rows: `<hex id>:<kind letters><payload>` per line. */
export function decodeRscFlight(
  text: string,
): { value: { id: string; kind: string; value: unknown }[]; truncated: boolean } | undefined {
  const rows: { id: string; kind: string; raw: string }[] = [];
  let truncated = false;
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{1,16}):([A-Z]{0,3})(.*)$/s.exec(line);
    if (match) {
      if (rows.length >= MAX_ITEMS) {
        truncated = true;
        break;
      }
      rows.push({ id: match[1] ?? "", kind: match[2] || "model", raw: match[3] ?? "" });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last) last.raw += "\n" + line;
    else if (line.trim()) return undefined;
  }
  if (!rows.length) return undefined;
  const value = rows.map((row) => {
    const raw = row.raw.replace(/\n$/, "");
    const parsed = parse(raw);
    return { id: row.id, kind: row.kind, value: parsed === undefined ? clip(raw) : parsed };
  });
  return { value, truncated };
}

/** Framed JSON streams: `&&&`-separated chunks, NDJSON, or length-prefixed chunks. */
export function decodeJsonSeq(text: string): { value: unknown[]; truncated: boolean } | undefined {
  const body = text.replace(XSSI, "");
  const chunks = body.includes("&&&")
    ? body.split("&&&")
    : (lengthPrefixed(body) ?? body.split("\n"));
  const values: unknown[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    if (values.length >= MAX_ITEMS) return { value: values, truncated: true };
    const value = parse(chunk);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values.length > 1 || (values.length === 1 && body.includes("&&&"))
    ? { value: values, truncated: false }
    : undefined;
}

/** `<length>\n<chunk><length>\n<chunk>…`, where each length counts the chunk's characters. */
function lengthPrefixed(body: string): string[] | undefined {
  const chunks: string[] = [];
  let at = 0;
  while (at < body.length) {
    const head = /^\s*(\d+)\n/.exec(body.slice(at, at + 24));
    if (!head) return body.slice(at).trim() ? undefined : chunks.length ? chunks : undefined;
    const size = Number(head[1]);
    const start = at + head[0].length;
    if (start + size > body.length + 1) return undefined;
    chunks.push(body.slice(start, start + size));
    at = start + size;
  }
  return chunks.length ? chunks : undefined;
}

/** Walks protobuf wire types without a schema. Undefined when the bytes are not protobuf. */
export function decodeProtobuf(
  bytes: Uint8Array,
  limits: { maxDepth?: number; maxNodes?: number } = {},
): { value: ProtobufField[]; truncated: boolean } | undefined {
  const ctx = {
    nodes: 0,
    maxDepth: limits.maxDepth ?? MAX_DEPTH,
    maxNodes: limits.maxNodes ?? MAX_NODES,
    truncated: false,
  };
  if (!bytes.byteLength) return undefined;
  const value = walk(bytes, 1, ctx);
  return value && value.length ? { value, truncated: ctx.truncated } : undefined;
}

interface WalkContext {
  nodes: number;
  maxDepth: number;
  maxNodes: number;
  truncated: boolean;
}

function walk(bytes: Uint8Array, depth: number, ctx: WalkContext): ProtobufField[] | undefined {
  const fields: ProtobufField[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    if (ctx.nodes >= ctx.maxNodes) {
      ctx.truncated = true;
      return fields;
    }
    const key = varint(bytes, at);
    if (!key || key.value > 0xffffffffn) return undefined;
    at = key.next;
    const field = Number(key.value >> 3n);
    const type = Number(key.value & 7n);
    if (field < 1 || field > 536_870_911) return undefined;
    ctx.nodes++;
    if (type === 0) {
      const read = varint(bytes, at);
      if (!read) return undefined;
      fields.push({ field, wire: "varint", value: big(read.value) });
      at = read.next;
    } else if (type === 1 || type === 5) {
      const size = type === 1 ? 8 : 4;
      if (at + size > bytes.byteLength) return undefined;
      let value = 0n;
      for (let index = size - 1; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[at + index] ?? 0);
      fields.push({ field, wire: type === 1 ? "fixed64" : "fixed32", value: big(value) });
      at += size;
    } else if (type === 2) {
      const length = varint(bytes, at);
      if (!length || length.value > BigInt(bytes.byteLength - length.next)) return undefined;
      const start = length.next;
      const end = start + Number(length.value);
      fields.push(delimited(field, bytes.subarray(start, end), depth, ctx));
      at = end;
    } else return undefined;
  }
  return fields;
}

/** A length-delimited field: readable text, else a nested message that parses cleanly, else bytes. */
function delimited(field: number, sub: Uint8Array, depth: number, ctx: WalkContext): ProtobufField {
  const text = utf8(sub);
  if (text !== undefined && printable(text)) return { field, wire: "string", value: clip(text) };
  if (sub.byteLength) {
    if (depth >= ctx.maxDepth) ctx.truncated = true;
    else {
      const before = { nodes: ctx.nodes, truncated: ctx.truncated };
      const children = walk(sub, depth + 1, ctx);
      if (children && children.length) return { field, wire: "message", children };
      ctx.nodes = before.nodes;
      ctx.truncated = before.truncated;
    }
  }
  const base64 = toBase64(sub.subarray(0, (MAX_LEAF_BASE64 / 4) * 3));
  if (sub.byteLength > (MAX_LEAF_BASE64 / 4) * 3) ctx.truncated = true;
  return { field, wire: "bytes", value: base64 };
}

function varint(bytes: Uint8Array, at: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    if (at + index >= bytes.byteLength) return undefined;
    const byte = bytes[at + index] ?? 0;
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if (!(byte & 0x80)) return { value, next: at + index + 1 };
  }
  return undefined;
}

function big(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

/** What a recorded request carried, decoded: protobuf query params and a framed or binary body. */
export function decodeRequestPayload(request: {
  url: string;
  body?: string | undefined;
  contentType?: string | undefined;
}): { query?: Record<string, WireDecodeResult>; body?: WireDecodeResult } | undefined {
  const out: { query?: Record<string, WireDecodeResult>; body?: WireDecodeResult } = {};
  let params: URLSearchParams | undefined;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    params = undefined;
  }
  let count = 0;
  for (const [name, value] of params ?? []) {
    if (++count > 50) break;
    const named = /proto|pb|_encoded|binary/i.test(name);
    if (value.length < (named ? 2 : 16) || !/^[A-Za-z0-9+/_-]+=*$/.test(value)) continue;
    const bytes = fromBase64(value);
    const decoded = bytes && decodeProtobuf(bytes);
    if (!bytes || !decoded) continue;
    // An ordinary token rarely decodes into nested fields or text; require one unless named.
    if (!named && !decoded.value.some((node) => node.wire === "message" || node.wire === "string"))
      continue;
    out.query = out.query ?? {};
    out.query[name] = {
      format: "protobuf",
      value: decoded.value,
      bytes: bytes.byteLength,
      truncated: decoded.truncated,
    };
  }
  if (request.body) {
    const body = decodeWireText(request.body, { mime: request.contentType, url: request.url });
    if (/^(protobuf|jspb|rsc|json-seq)$/.test(body.format)) out.body = body;
  }
  return out.query || out.body ? out : undefined;
}

/** Base64 (standard or URL-safe) to bytes, or undefined when it is not base64. */
export function fromBase64(value: string): Uint8Array | undefined {
  try {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Text a person could read: no control characters besides tab and line breaks. */
function printable(text: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/.test(text);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.length > MAX_LEAF_TEXT ? text.slice(0, MAX_LEAF_TEXT) + "…" : text;
}
