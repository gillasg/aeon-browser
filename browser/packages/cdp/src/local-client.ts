import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Why a request is not from this machine's loopback, or undefined when it is.
 * A missing Origin is allowed: Playwright's connectOverCDP does not send one.
 */
export function localRefusal(headers: IncomingHttpHeaders): string | undefined {
  if (!loopbackHost(oneHeader(headers.host)))
    return "Host must be loopback (127.0.0.1, localhost, or [::1]).";
  if (!originAllowed(oneHeader(headers.origin)))
    return "A cross-origin request cannot use this endpoint.";
  return undefined;
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

function loopbackHost(value: string | undefined): boolean {
  const name = hostName(value);
  return name !== undefined && LOOPBACK.has(name);
}

function hostName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (text.startsWith("[")) return bracketHost(text);
  const parts = text.split(":");
  if (parts.length === 1) return parts[0];
  if (parts.length !== 2 || !portOk(parts[1])) return text === "::1" ? text : undefined;
  return parts[0] || undefined;
}

function bracketHost(text: string): string | undefined {
  const end = text.indexOf("]");
  if (end <= 1) return undefined;
  const tail = text.slice(end + 1);
  if (tail !== "" && !portSuffix(tail)) return undefined;
  return text.slice(1, end) || undefined;
}

function portSuffix(tail: string): boolean {
  return tail.startsWith(":") && portOk(tail.slice(1));
}

function portOk(text: string | undefined): boolean {
  if (!text || !/^\d+$/.test(text)) return false;
  const port = Number(text);
  return port > 0 && port <= 65535;
}

function originAllowed(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return false;
  }
}
