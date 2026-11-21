// Manage routes in the hash, so an open Manage tab can be sent somewhere without a reload:
// `#sites?host=flipkart.com`, `#models`, `#watches`, `#forms`, `#blocked`, `#learn`.

export interface HashRoute {
  page: string;
  host: string;
}

export function parseHashRoute(hash: string): HashRoute {
  const match = /^#([a-z]+)(?:\?(.*))?$/i.exec(hash);
  if (!match) return { page: "", host: "" };
  const host = new URLSearchParams(match[2] ?? "").get("host") ?? "";
  return { page: (match[1] ?? "").toLowerCase(), host: host.trim().slice(0, 200) };
}

export function hashRoute(): HashRoute {
  return parseHashRoute(globalThis.location?.hash ?? "");
}
