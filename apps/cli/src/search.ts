import type { AeonClient } from "./client.js";

// Read-only search over what Aeon already knows: chat titles and messages (the daemon's catalog
// search) and the answers kept on home (pins). Nothing here starts a run or changes a chat.

export interface SearchFilters {
  origin?: string;
  since?: string;
  until?: string;
}

export interface ChatHit {
  chatId: string;
  title: string;
  origin?: string;
  status?: string;
  updatedAt?: string;
  matchExcerpt?: string;
}

export interface PinHit {
  pinId: string;
  title: string;
  value: string;
  detail?: string;
  condition?: string;
  source: string;
  site?: string;
  operation?: string;
  chatId?: string;
  updatedAt?: string;
}

export interface SearchResult {
  query: string;
  chats: ChatHit[];
  pins: PinHit[];
}

export async function searchAeon(
  client: AeonClient,
  text: string,
  filters: SearchFilters = {},
  limit = 20,
): Promise<SearchResult> {
  const query = text.trim();
  if (!query) throw new Error('Usage: aeon search "<text>"');
  const listed = await client.command("chat.list", {
    limit: Math.min(100, Math.max(1, limit)),
    includeArchived: true,
    query,
    ...(filters.origin ? { origin: filters.origin } : {}),
    ...(filters.since ? { since: `${filters.since}T00:00:00.000Z` } : {}),
    ...(filters.until ? { until: nextDay(filters.until) } : {}),
  });
  const management = await client.command("management.get", {});
  const pins = ((management.snapshot as { pins?: PinHit[] } | undefined)?.pins ?? [])
    .filter((pin) => matches(pin, query))
    .slice(0, limit);
  return { query, chats: (listed.chats as ChatHit[] | undefined) ?? [], pins };
}

function matches(pin: PinHit, query: string): boolean {
  const wanted = query.toLowerCase();
  return [pin.title, pin.value, pin.detail, pin.condition, pin.site, pin.operation]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(wanted));
}

/** The start of the next UTC day, for an inclusive `--until YYYY-MM-DD`. */
export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();
}
