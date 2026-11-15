// The framed messages shared by the host, the supervisor and the daemon, and the small helpers
// that decide what is allowed in them. Keep these rules identical to the C# host.

export const PROTOCOL_VERSION = { major: 1, minor: 1 };
export const MAX_MESSAGE_BYTES = 16384;
const GRANT_BYTES = 22000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function matchesOrigin(received, expected) {
  let parsed;
  try {
    parsed = new URL(received);
  } catch {
    return false;
  }
  if (parsed.protocol !== "chrome-extension:") return false;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return false;
  return "chrome-extension://" + parsed.host === expected;
}

export function failure(code, retryable) {
  return Buffer.from(
    JSON.stringify({
      kind: "native.bootstrap.result",
      protocolVersion: PROTOCOL_VERSION,
      ok: false,
      code,
      retryable,
      supportedProtocolVersion: PROTOCOL_VERSION,
    }),
    "utf8",
  );
}

/** The envelope the host puts on the supervisor socket. */
export function bootstrapEnvelope(origin, request) {
  return {
    kind: "supervisor.bootstrap",
    origin: "chrome-extension://" + new URL(origin).host,
    requestBase64: request.toString("base64"),
  };
}

/** Validates an envelope and returns the daemon request bytes, or a failure code. */
export function readEnvelope(candidate, extensionOrigin) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return "ORIGIN_NOT_ALLOWED";
  if (Object.keys(candidate).length !== 3) return "ORIGIN_NOT_ALLOWED";
  if (candidate.kind !== "supervisor.bootstrap") return "ORIGIN_NOT_ALLOWED";
  if (candidate.origin !== extensionOrigin) return "ORIGIN_NOT_ALLOWED";
  return envelopeRequest(candidate.requestBase64);
}

function envelopeRequest(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > GRANT_BYTES)
    return "INVALID_REQUEST";
  if (!BASE64.test(encoded)) return "INVALID_REQUEST";
  const request = Buffer.from(encoded, "base64");
  if (request.length === 0 || request.length > MAX_MESSAGE_BYTES) return "INVALID_REQUEST";
  return request;
}

export function isStopRequest(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const keys = Object.keys(candidate);
  return keys.length === 1 && candidate.kind === "supervisor.stop";
}

export function isHealthLine(line) {
  try {
    return JSON.parse(Buffer.from(line, "base64").toString("utf8")).kind === "supervisor.health";
  } catch {
    return false;
  }
}

export function healthRequestLine() {
  return Buffer.from(JSON.stringify({ kind: "supervisor.health" }), "utf8").toString("base64");
}

/** A line the daemon wrote itself: a base64 reply, a known progress marker, or something stray. */
export function phaseOf(line) {
  const marker = "AEON_DAEMON_PHASE ";
  if (typeof line !== "string" || !line.startsWith(marker)) return undefined;
  return line.slice(marker.length).trim();
}

export function isBase64(line) {
  return typeof line === "string" && line.length > 0 && line.length % 4 === 0 && BASE64.test(line);
}

/** True when a health reply proves the daemon's event loop answered. */
export function isAliveAnswer(line) {
  if (!isBase64(line)) return false;
  try {
    const text = Buffer.from(line, "base64").toString("utf8");
    return text.includes('"supervisor.health.result"') || text.includes('"BOOTSTRAP_UNAVAILABLE"');
  } catch {
    return false;
  }
}

/** One crash restarts in 1 s; a start that never became ready backs off up to 30 s. */
export function restartDelay(failures) {
  if (failures === 0) return 1000;
  return Math.min(30000, 500 * 2 ** Math.min(failures, 6));
}
