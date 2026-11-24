// Recorded network entries, their compact summaries for listing, and HAR 1.2 export.
export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  /** CDP resource type: XHR, Fetch, Document, EventSource, WebSocket… */
  type: string;
  startedAt: number;
  frameId?: string;
  /** The frame or worker that made the request, when it was not the top frame. */
  frameUrl?: string;
  /** Where it ran: the top frame, an out-of-process iframe, a worker or a service worker. */
  source?: "worker" | "service-worker";
  /** The child debugger session that carried it, for body reads. */
  sessionId?: string;
  documentURL?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyPending?: boolean;
  /** What made the request: the script and its call stack (useful for finding signing code). */
  initiator?: {
    type: string;
    url?: string;
    stack?: { url: string; functionName: string; line: number }[];
  };
  redirects?: {
    url: string;
    status: number;
    headers: Record<string, string>;
    /** 0 for the first hop. */
    hop?: number;
    /** The request headers sent for this hop. */
    requestHeaders?: Record<string, string>;
    /** False when no extra info arrived for this hop (cached, or served by a service worker). */
    extraInfo?: boolean;
  }[];
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  protocol?: string;
  /** The address the browser connected to (its own resolver, after DoH/hosts). */
  remoteIPAddress?: string;
  /** Set when a response came from a private address the URL preflight could not see (rebinding). */
  privateNetwork?: string;
  size?: number;
  durationMs?: number;
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
  bodyBytes?: number;
  bodyDropped?: boolean;
  frames?: { direction: "sent" | "received"; at: number; opcode: number; data: string }[];
  messages?: { at: number; event: string; data: string }[];
  failed?: string;
  /** Cancelled before it finished (navigation away, AbortController): kept, not a failure. */
  aborted?: boolean;
  /** Capture stopped while the request was still open: what arrived so far. */
  partial?: boolean;
  done: boolean;
}

export function summarize(entry: NetworkEntry): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    type: entry.type,
  };
  if (entry.status !== undefined) summary.status = entry.status;
  if (entry.mimeType) summary.mimeType = entry.mimeType;
  if (entry.remoteIPAddress) summary.remoteIPAddress = entry.remoteIPAddress;
  if (entry.privateNetwork) summary.privateNetwork = entry.privateNetwork;
  if (entry.size !== undefined) summary.size = entry.size;
  summary.json = /json/i.test(entry.mimeType ?? "");
  summary.state = entry.failed ? "failed" : entry.done ? "done" : "pending";
  if (entry.frameUrl) summary.frameUrl = entry.frameUrl;
  if (entry.source) summary.source = entry.source;
  if (entry.documentURL) summary.documentURL = entry.documentURL;
  if (entry.requestBody !== undefined) summary.requestBody = entry.requestBody.slice(0, 2000);
  if (entry.initiator?.url) summary.initiator = entry.initiator.url;
  if (!entry.done) summary.loading = true;
  if (entry.failed) summary.failed = entry.failed;
  if (entry.frames) summary.frames = entry.frames.length;
  if (entry.messages) summary.messages = entry.messages.length;
  return summary;
}

type HarHeader = { name: string; value: string };

const SECRET_HEADERS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|x-amz-security-token)$|token|secret|session|password|signature|x-.*-key$/i;
const SECRET_KEYS =
  /^(password|passwd|pwd|pass|secret|client_secret|token|access_?token|refresh_?token|id_?token|api_?key|apikey|authorization|auth|session(_?id)?|sid|ssn|card_?number|cc_?number|cvv|cvc|otp|pin|private_?key|csrf(_?token)?|xsrf(_?token)?|authenticity_token)$/i;
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?<![\w/.-])\+?\d[\d\s().-]{8,}\d(?![\w/.-])/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/** Text patterns no HAR viewer needs: tokens, addresses, card and phone numbers. */
const TEXT_CAP = 262_144;

export function redactHarText(value: string): string {
  if (value.length > TEXT_CAP)
    return `[truncated ${value.length - TEXT_CAP} chars; redactHarText cap ${TEXT_CAP}]`;
  return value
    .replace(JWT, "<redacted>")
    .replace(EMAIL, "<redacted>")
    .replace(CARD, (match) => (luhn(match.replace(/\D/g, "")) ? "<redacted>" : match))
    .replace(PHONE, (match) => (match.replace(/\D/g, "").length >= 10 ? "<redacted>" : match));
}

function luhn(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function redactHarUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const [name, value] of [...parsed.searchParams])
      parsed.searchParams.set(
        name,
        SECRET_KEYS.test(name) || /key|token|sig|secret/i.test(name)
          ? "<redacted>"
          : redactHarText(value),
      );
    parsed.pathname = redactHarText(parsed.pathname);
    return parsed.href.replace(/%3Credacted%3E/gi, "<redacted>");
  } catch {
    return redactHarText(url);
  }
}

export function redactHarHeaders(
  headers: Record<string, string> | undefined,
  raw = false,
): HarHeader[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    name,
    value: raw ? value : SECRET_HEADERS.test(name) ? "<redacted>" : redactHarText(value),
  }));
}

function redactHarCookies(header: string | undefined, raw: boolean): HarHeader[] {
  if (!header) return [];
  return header
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      return {
        name,
        value: raw ? pair.slice(index + 1) : "<redacted>",
      };
    });
}

/** Values of headers whose names are secrets, plus cookie values, bearer tokens, and encodings. */
export function secretHeaderValues(...groups: Array<Record<string, string> | undefined>): string[] {
  const values: string[] = [];
  for (const headers of groups)
    for (const [name, value] of Object.entries(headers ?? {}))
      if (value && SECRET_HEADERS.test(name)) values.push(...headerSecrets(name, value));
  return [...new Set(values)];
}

function headerSecrets(name: string, value: string): string[] {
  return [value, ...cookieValues(name, value), ...authTokens(value)].flatMap(secretForms);
}

function cookieValues(name: string, value: string): string[] {
  const lower = name.toLowerCase();
  if (lower !== "cookie" && lower !== "set-cookie") return [];
  const pairs = lower === "set-cookie" ? value.split(";").slice(0, 1) : value.split(";");
  const found: string[] = [];
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index > 0) found.push(pair.slice(index + 1).trim());
  }
  return found;
}

function authTokens(value: string): string[] {
  const match = /^(?:bearer|basic)\s+(\S+)/i.exec(value.trim());
  return match?.[1] ? [match[1]] : [];
}

function secretForms(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const forms = [trimmed];
  pushEncoded(forms, trimmed);
  forms.push(...base64Forms(trimmed));
  return forms;
}

function base64Forms(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const padded = btoa(binary);
  const bare = padded.replace(/=+$/, "");
  return [
    padded,
    bare,
    padded.replaceAll("+", "-").replaceAll("/", "_"),
    bare.replaceAll("+", "-").replaceAll("/", "_"),
  ];
}

function pushEncoded(forms: string[], value: string): void {
  try {
    const encoded = encodeURIComponent(value);
    if (encoded !== value) forms.push(encoded);
  } catch {
    // The value is not a URI component. The raw form is already listed.
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) forms.push(decoded);
  } catch {
    // The value is not percent-encoded.
  }
}

/**
 * Replaces secret header values echoed in a body. A value under 8 characters is replaced only
 * where it stands alone, so a short token cannot cut a word in half.
 */
export function redactSecretValues(text: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  let result = text;
  for (const value of values) result = applySecret(result, value);
  return result;
}

function applySecret(text: string, value: string): string {
  if (value.length >= 8) return text.split(value).join("<redacted>");
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "<redacted>");
}

export function redactHarBody(
  body: string | undefined,
  raw: boolean,
  secrets: readonly string[] = [],
): string | undefined {
  if (body === undefined || raw) return body;
  try {
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            SECRET_KEYS.test(key) && typeof item !== "object" ? "<redacted>" : redact(item),
          ]),
        );
      return typeof value === "string" ? redactString(value, secrets) : value;
    };
    return JSON.stringify(redact(JSON.parse(body)));
  } catch {
    return redactString(body, secrets);
  }
}

/** One `\u` decode and one URI decode, for a body that is not JSON or still holds those forms. */
function decodeSecretLayers(body: string): string {
  const unicode = body.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  try {
    return decodeURIComponent(unicode);
  } catch {
    return unicode;
  }
}

function redactString(value: string, secrets: readonly string[]): string {
  const direct = redactSecretValues(redactHarText(value), secrets);
  const decoded = decodeSecretLayers(value);
  if (decoded === value) return direct;
  const plain = redactHarText(decoded);
  const cleaned = redactSecretValues(plain, secrets);
  return cleaned === plain ? direct : cleaned;
}

export function redactHarQuery(url: string, raw = false): HarHeader[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({
      name,
      value: raw
        ? value
        : SECRET_KEYS.test(name) || /key|token|sig|secret/i.test(name)
          ? "<redacted>"
          : redactHarText(value),
    }));
  } catch {
    return [];
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const key = Object.keys(headers ?? {}).find((item) => item.toLowerCase() === name);
  return key ? headers?.[key] : undefined;
}

function harEntry(entry: NetworkEntry, raw: boolean): Record<string, unknown> {
  const requestType = header(entry.requestHeaders, "content-type") ?? "";
  const secrets = secretHeaderValues(entry.requestHeaders, entry.responseHeaders);
  return {
    startedDateTime: new Date(entry.startedAt).toISOString(),
    time: entry.durationMs ?? 0,
    _resourceType: entry.type.toLowerCase(),
    _initiator: entry.initiator,
    request: {
      method: entry.method,
      url: raw ? entry.url : redactHarUrl(entry.url),
      httpVersion: entry.protocol ?? "HTTP/1.1",
      headers: redactHarHeaders(entry.requestHeaders, raw),
      queryString: redactHarQuery(entry.url, raw),
      cookies: redactHarCookies(header(entry.requestHeaders, "cookie"), raw),
      headersSize: -1,
      bodySize: entry.requestBody?.length ?? 0,
      ...(entry.requestBody !== undefined
        ? {
            postData: {
              mimeType: requestType,
              text: redactHarBody(entry.requestBody, raw, secrets) ?? "",
            },
          }
        : {}),
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? entry.failed ?? "",
      httpVersion: entry.protocol ?? "HTTP/1.1",
      headers: redactHarHeaders(entry.responseHeaders, raw),
      cookies: redactHarCookies(header(entry.responseHeaders, "set-cookie"), raw),
      content: {
        size: entry.bodyBytes ?? entry.size ?? 0,
        mimeType: entry.mimeType ?? "",
        ...(entry.body !== undefined
          ? { text: redactHarBody(entry.body, raw, secrets) ?? "" }
          : {}),
      },
      redirectURL: header(entry.responseHeaders, "location") ?? "",
      headersSize: -1,
      bodySize: entry.size ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
    ...(entry.frames ? { _webSocketMessages: entry.frames } : {}),
    ...(entry.messages ? { _eventSourceMessages: entry.messages } : {}),
  };
}

/** HAR 1.2, readable by browser DevTools and every HAR tool. Redacted unless raw is true. */
export function toHar(
  entries: NetworkEntry[],
  options: { raw?: boolean } = {},
): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      creator: { name: "browserkit", version: "1" },
      pages: [],
      entries: entries
        .filter((entry) => entry.done || entry.type === "WebSocket")
        .map((entry) => harEntry(entry, options.raw === true)),
    },
  };
}
