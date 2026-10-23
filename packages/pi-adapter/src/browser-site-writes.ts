// Writes a browser_code cell sent through a site's API (siteMapper.write / siteMapper.batch), counted
// per operation so the step can say what it changed: the Activity log lists them, with the
// items, and the orb shows them on the result.

export interface SiteWrite {
  site: string;
  operation: string;
  done: number;
  failed: number;
  /** A short label per item that went through, for the Activity log. */
  items: string[];
  /** The values each item was written with, so Activity can reverse them. */
  params: Record<string, unknown>[];
}

const MAX_ITEMS = 200;

export class SiteWrites {
  private readonly writes = new Map<string, SiteWrite>();
  /** The cell called a mapped site API at all (read or write). */
  usedApi = false;

  track(request: unknown, sent: Promise<unknown>): Promise<unknown> {
    const call = request as {
      siteMapper?: string;
      site?: string;
      operation?: string;
      params?: unknown;
    };
    if (call.siteMapper === "call" || call.siteMapper === "write" || call.siteMapper === "watch")
      this.usedApi = true;
    if (call.siteMapper !== "write" || !call.site || !call.operation) return sent;
    const key = call.site + "|" + call.operation;
    const write = this.writes.get(key) ?? {
      site: call.site,
      operation: call.operation,
      done: 0,
      failed: 0,
      items: [],
      params: [],
    };
    this.writes.set(key, write);
    return sent.then(
      (value) => {
        write.done += 1;
        if (write.items.length < MAX_ITEMS) write.items.push(itemLabel(call.params));
        if (write.params.length < MAX_ITEMS) write.params.push(itemParams(call.params));
        return value;
      },
      (error: unknown) => {
        write.failed += 1;
        throw error;
      },
    );
  }

  list(): SiteWrite[] {
    return [...this.writes.values()];
  }
}

/** The values that tell one item from another: `row-111`, `"First video"`. */
function itemLabel(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  return Object.values(params as Record<string, unknown>)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String)
    .join(" · ")
    .slice(0, 80);
}

/** The item's values as they were sent, kept so Undo can send the reverse for the same item. */
function itemParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>).slice(0, 20)) {
    if (typeof value === "string") kept[key] = value.slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean" || value === null)
      kept[key] = value;
  }
  return kept;
}
