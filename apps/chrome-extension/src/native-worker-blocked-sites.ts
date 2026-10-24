import { NativeBlockedSitesRequestSchema } from "@aeon/protocol";

// `aeon block|unblock|blocked` from the CLI. The list is the user's own (settings → Blocked
// sites), mirrored from page localStorage into chrome.storage.local under "blocked-sites", where
// the engine reads it at every step. Changing it here is the same change the settings page makes;
// open pages follow through chrome.storage.onChanged. No chat tool reaches this message.

const BLOCKED_SITES_KEY = "blocked-sites";

export function handleBlockedSitesMessage(candidate: unknown, socket: WebSocket): boolean {
  const request = NativeBlockedSitesRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, action, site, sites } = request.data;
  void apply(action, site, sites).then(
    (next) =>
      socket.send(JSON.stringify({ kind: "native.blocked-sites.result", requestId, sites: next })),
    (error: unknown) =>
      socket.send(
        JSON.stringify({
          kind: "native.blocked-sites.result",
          requestId,
          sites: [],
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        }),
      ),
  );
  return true;
}

async function apply(
  action: "read" | "add" | "remove" | "replace",
  site: string | undefined,
  sites: string[] | undefined,
): Promise<string[]> {
  if (action === "replace") {
    const next = [...new Set((sites ?? []).map(String))].sort();
    await chrome.storage.local.set({ [BLOCKED_SITES_KEY]: next });
    return next;
  }
  const current = await read();
  if (action === "read") return current;
  if (!site) throw new Error("A site is required to block or unblock one.");
  const next =
    action === "add"
      ? [...new Set([...current, site])].sort()
      : current.filter((item) => item !== site);
  await chrome.storage.local.set({ [BLOCKED_SITES_KEY]: next });
  return next;
}

async function read(): Promise<string[]> {
  const stored = await chrome.storage.local.get(BLOCKED_SITES_KEY);
  const value = stored[BLOCKED_SITES_KEY];
  return Array.isArray(value) ? value.map(String) : [];
}
