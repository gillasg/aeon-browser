// Rows the page already fetched, when those rows are the list on screen.

export interface HarvestHit {
  name: string;
  count: number;
  rows: Record<string, unknown>[];
}

const ROW_CAP = 200;

export function harvestCaptured(
  entries: Iterable<{ url?: string; body?: string }>,
  options: { visible?: unknown } = {},
): HarvestHit {
  const visible = String(options.visible ?? "");
  let best: HarvestHit = { name: "", count: 0, rows: [] };
  for (const entry of entries) {
    const rows = rowsFrom(entry.body);
    if (!rows) continue;
    const matched = rows.filter((row) => rowMatches(row, visible));
    if (matched.length < 2 || matched.length / rows.length < 0.3) continue;
    if (rows.length <= best.count) continue;
    best = { name: nameFrom(entry.url ?? ""), count: rows.length, rows: rows.slice(0, ROW_CAP) };
  }
  return best;
}

function rowsFrom(body: string | undefined): Record<string, unknown>[] | undefined {
  if (!body || body.length < 4 || body.length > 2_000_000) return undefined;
  const parsed = parseJson(body);
  const rows =
    asRows(parsed) ?? asRows(parsed && typeof parsed === "object" ? nested(parsed) : undefined);
  if (!rows || rows.length < 2 || rows.length > 5000) return undefined;
  return rows;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function nested(value: object): unknown {
  const record = value as Record<string, unknown>;
  return record.items ?? record.rows ?? record.data ?? record.orders ?? record.results;
}

function asRows(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || !value.every(isObject)) return undefined;
  return value as Record<string, unknown>[];
}

function isObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rowMatches(row: Record<string, unknown>, visible: string): boolean {
  if (!visible) return false;
  return Object.values(row).some(
    (value) =>
      typeof value === "string" && value.trim().length >= 4 && visible.includes(value.trim()),
  );
}

export function harvestReply(
  entries: Iterable<{ url?: string; body?: string }>,
  options: { visible?: unknown; name?: unknown; footer?: unknown } = {},
): { name: string; count: number; rows: Record<string, unknown>[]; line: string } {
  const hit = harvestCaptured(entries, { visible: options.visible });
  const asked = typeof options.name === "string" ? options.name : "";
  const use = asked && hit.name !== asked ? { name: asked, count: 0, rows: [] } : hit;
  const line = use.count
    ? `[data] ${use.count} ${use.name} already loaded by this page: page.data('${use.name}')`
    : "";
  if (options.footer === true) return { name: use.name, count: use.count, rows: [], line };
  return { name: use.name, count: use.count, rows: use.rows, line };
}

function nameFrom(url: string): string {
  const path = url.toLowerCase();
  const known = ["orders", "results", "items", "products", "messages", "bookings"].find((name) =>
    path.includes(name),
  );
  if (known) return known;
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
    return segment && /^[a-z0-9-]{2,32}$/.test(segment) ? segment : "rows";
  } catch {
    return "rows";
  }
}
