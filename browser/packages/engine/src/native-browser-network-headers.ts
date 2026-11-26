// Header and address rules for the network recorder, kept apart so each stays testable.

/**
 * A request that went through a local proxy (a SOCKS endpoint such as 127.0.0.1:1081) reports
 * the proxy as its remote address. That is a loopback address on the proxy's own port, not the
 * URL's: a DNS-rebinding answer would connect to the URL's port. Not a rebinding result.
 */
export function localProxyHop(url: string, ip: string, port: unknown): boolean {
  if (!/^(127\.|::1$|\[::1\]$)/.test(ip) || typeof port !== "number") return false;
  try {
    const parsed = new URL(url);
    if (/^(localhost|127\.|\[::1\])/.test(parsed.hostname)) return false;
    const urlPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return port !== urlPort;
  } catch {
    return false;
  }
}

/** Later headers replace earlier ones by name, whatever their case, so values never double. */
export function replaceHeaders(
  old: Record<string, string> | undefined,
  next: Record<string, string>,
): Record<string, string> {
  const lower = new Set(Object.keys(next).map((name) => name.toLowerCase()));
  const kept = Object.entries(old ?? {}).filter(([name]) => !lower.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...next };
}
