// The user's history: search it, page through all of it, and rank the sites and sections they
// use most ("my most visited subreddits", "the docs I keep opening").
// Without since/until, visit counts are Chrome's per-URL totals, so a page first seen inside the
// days window still carries its older visits. With since and/or until, each URL is counted from
// chrome.history.getVisits inside that window, and the result includes those visit times.
const PAGE = 5000;
const MAX_SEARCH = 5000;
const MAX_SCAN = 200_000;
const MAX_TIMES = 100;
const VISIT_CAP = 4000;
const VISIT_CONCURRENCY = 8;
const DAY_MS = 86_400_000;

type Request = Record<string, unknown>;
type Item = chrome.history.HistoryItem;

interface HistoryApi {
  search(query: chrome.history.HistoryQuery): Promise<Item[]>;
  getVisits(details: chrome.history.UrlDetails): Promise<chrome.history.VisitItem[]>;
}

interface Span {
  since: number;
  until: number | undefined;
}

interface Tally {
  count: number;
  last: number;
  times: number[];
  truncated: boolean;
}

interface CountedHit {
  url: string;
  title: string | undefined;
  lastVisit: string;
  visits: number;
  times: string[];
  timesTruncated?: true;
  last: number;
}

interface Group {
  key: string;
  visits: number;
  pages: number;
  last: number;
  best?: Item;
  bestVisits: number;
  times: number[];
  timesTruncated?: true;
}

interface Picked {
  item: Item;
  url: string;
  key: string;
}

export async function historyCall(
  action: string,
  value: Request,
  api: HistoryApi = chromeHistory(),
): Promise<unknown> {
  if (action === "search") return search(value, api);
  if (action === "top") return top(value, api);
  throw new Error("UNSUPPORTED: browser.history." + action);
}

function chromeHistory(): HistoryApi {
  return {
    search: (query) => chrome.history.search(query),
    getVisits: (details) => chrome.history.getVisits(details),
  };
}

function startTime(value: Request, fallbackDays: number): number {
  const days = Math.min(3650, Math.max(0, Number(value.days ?? fallbackDays)));
  return days ? Date.now() - days * DAY_MS : 0;
}

/** `before` pages backwards: an ISO time or ms, usually the last item's lastVisit. */
function timeOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : undefined;
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** since/until: ms, ISO, or YYYY-MM-DD (a date-only until includes that whole UTC day). */
function parseTime(value: unknown, end: boolean): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const text = String(value).trim();
  if (/^\d{13}$/.test(text)) return Number(text);
  const date = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  const day = date?.[1];
  if (day) {
    const start = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(start)) return undefined;
    return end ? start + DAY_MS - 1 : start;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

function visitSpan(value: Request): Span | undefined {
  const hasSince = given(value.since);
  const hasUntil = given(value.until);
  if (!hasSince && !hasUntil) return undefined;
  const since = hasSince ? parseTime(value.since, false) : 0;
  const until = hasUntil ? parseTime(value.until, true) : undefined;
  if (hasSince && since === undefined) throw new Error("INVALID_HISTORY: since is not a time");
  if (hasUntil && until === undefined) throw new Error("INVALID_HISTORY: until is not a time");
  return { since: since ?? 0, until };
}

function inverted(span: Span): boolean {
  return span.until !== undefined && span.since > span.until;
}

function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function searchQuery(value: Request, span: Span | undefined): chrome.history.HistoryQuery {
  const before = timeOf(value.before);
  const untilEnd = span?.until !== undefined ? span.until + 1 : undefined;
  const endTime = earliest(before !== undefined ? before - 1 : undefined, untilEnd);
  const query: chrome.history.HistoryQuery = {
    text: String(value.text ?? ""),
    startTime: span ? span.since : startTime(value, 30),
    maxResults: count(value.max, 50, MAX_SEARCH),
  };
  if (endTime !== undefined) query.endTime = endTime;
  return query;
}

function inWindow(time: number, span: Span, before: number | undefined): boolean {
  if (time < span.since) return false;
  if (span.until !== undefined && time > span.until) return false;
  if (before !== undefined && time >= before) return false;
  return true;
}

async function visitsIn(
  api: HistoryApi,
  url: string,
  span: Span,
  before: number | undefined,
): Promise<Tally> {
  const hits = await api.getVisits({ url });
  const times = hits
    .map((visit) => visit.visitTime)
    .filter((time): time is number => time !== undefined && inWindow(time, span, before))
    .sort((left, right) => right - left);
  return {
    count: times.length,
    last: times[0] ?? 0,
    times: times.slice(0, MAX_TIMES),
    truncated: times.length > MAX_TIMES,
  };
}

async function mapLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.min(VISIT_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, () => drain()));
  return results;

  async function drain(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await run(item);
    }
  }
}

function isoTimes(times: number[]): string[] {
  return times.slice(0, MAX_TIMES).map((time) => new Date(time).toISOString());
}

async function search(value: Request, api: HistoryApi): Promise<unknown> {
  const span = visitSpan(value);
  if (span && inverted(span)) return [];
  const items = await api.search(searchQuery(value, span));
  if (!span) return items.map(record);
  const before = timeOf(value.before);
  const rows = await mapLimited(uniqueItems(items), (item) => countedHit(item, api, span, before));
  return rows
    .filter((row): row is CountedHit => row !== undefined)
    .sort((left, right) => right.last - left.last)
    .map(publishHit);
}

function uniqueItems(items: Item[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

async function countedHit(
  item: Item,
  api: HistoryApi,
  span: Span,
  before: number | undefined,
): Promise<CountedHit | undefined> {
  if (!item.url) return undefined;
  const tally = await visitsIn(api, item.url, span, before);
  if (!tally.count) return undefined;
  const hit: CountedHit = {
    url: item.url,
    title: item.title,
    lastVisit: new Date(tally.last).toISOString(),
    visits: tally.count,
    times: isoTimes(tally.times),
    last: tally.last,
  };
  if (tally.truncated) hit.timesTruncated = true;
  return hit;
}

function publishHit(hit: CountedHit): unknown {
  const published: Record<string, unknown> = {
    url: hit.url,
    title: hit.title,
    lastVisit: hit.lastVisit,
    visits: hit.visits,
    times: hit.times,
  };
  if (hit.timesTruncated) published.timesTruncated = true;
  return published;
}

function record(item: Item): unknown {
  return {
    url: item.url,
    title: item.title,
    lastVisit: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
    visits: item.visitCount,
  };
}

/** Every item in the window, paged by end time, up to MAX_SCAN. */
async function scanAll(
  api: HistoryApi,
  text: string,
  start: number,
  endAt: number,
): Promise<{ items: Item[]; truncated: boolean }> {
  const items: Item[] = [];
  let end = endAt;
  while (items.length < MAX_SCAN) {
    const page = await api.search({ text, startTime: start, endTime: end, maxResults: PAGE });
    items.push(...page);
    const oldest = page.at(-1)?.lastVisitTime;
    if (page.length < PAGE || !oldest || oldest >= end) return { items, truncated: false };
    end = oldest;
  }
  return { items, truncated: true };
}

/** The group an URL belongs to: its site (host without www.) or the site plus its first path parts. */
function groupKey(url: string, by: string, depth: number): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(parsed.protocol)) return undefined;
  const host = parsed.hostname.replace(/^www\./, "");
  if (by !== "path") return host;
  const parts = parsed.pathname.split("/").filter(Boolean).slice(0, depth);
  return [host, ...parts].join("/");
}

function fresh(key: string): Group {
  return { key, visits: 0, pages: 0, last: 0, bestVisits: 0, times: [] };
}

function addTo(groups: Map<string, Group>, key: string, item: Item): void {
  const group = groups.get(key) ?? fresh(key);
  group.visits += item.visitCount ?? 0;
  group.pages += 1;
  group.last = Math.max(group.last, item.lastVisitTime ?? 0);
  if (!group.best || (item.visitCount ?? 0) > (group.best.visitCount ?? 0)) group.best = item;
  groups.set(key, group);
}

function addTally(groups: Map<string, Group>, key: string, item: Item, tally: Tally): void {
  const group = groups.get(key) ?? fresh(key);
  group.visits += tally.count;
  group.pages += 1;
  group.last = Math.max(group.last, tally.last);
  if (!group.best || tally.count > group.bestVisits) {
    group.best = item;
    group.bestVisits = tally.count;
  }
  group.times.push(...tally.times);
  if (tally.truncated) group.timesTruncated = true;
  groups.set(key, group);
}

function matches(item: Item, match: string): boolean {
  if (!match) return true;
  return `${item.url ?? ""} ${item.title ?? ""}`.toLowerCase().includes(match);
}

function groupTotals(items: Item[], by: string, value: Request): Group[] {
  const depth = count(value.depth, 2, 6);
  const match = String(value.match ?? "").toLowerCase();
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = item.url && matches(item, match) ? groupKey(item.url, by, depth) : undefined;
    if (key) addTo(groups, key, item);
  }
  return [...groups.values()];
}

function pickRow(item: Item, by: string, depth: number, match: string): Picked | undefined {
  if (!item.url || !matches(item, match)) return undefined;
  const key = groupKey(item.url, by, depth);
  if (!key) return undefined;
  return { item, url: item.url, key };
}

function pickUrls(
  items: Item[],
  by: string,
  depth: number,
  match: string,
): { rows: Picked[]; truncated: boolean } {
  const seen = new Set<string>();
  const rows: Picked[] = [];
  for (const item of items) {
    const row = pickRow(item, by, depth, match);
    if (!row || seen.has(row.url)) continue;
    if (rows.length >= VISIT_CAP) return { rows, truncated: true };
    seen.add(row.url);
    rows.push(row);
  }
  return { rows, truncated: false };
}

async function groupVisits(
  items: Item[],
  by: string,
  value: Request,
  api: HistoryApi,
  span: Span,
): Promise<{ groups: Group[]; truncated: boolean }> {
  const depth = count(value.depth, 2, 6);
  const match = String(value.match ?? "").toLowerCase();
  const picked = pickUrls(items, by, depth, match);
  const tallies = await mapLimited(picked.rows, (row) => visitsIn(api, row.url, span, undefined));
  const groups = new Map<string, Group>();
  for (let index = 0; index < picked.rows.length; index += 1) {
    const row = picked.rows[index];
    const tally = tallies[index];
    if (!row || !tally?.count) continue;
    addTally(groups, row.key, row.item, tally);
  }
  return { groups: [...groups.values()], truncated: picked.truncated };
}

/** Rank sites or sections. since/until counts visits in that window; otherwise totals are all-time. */
async function top(value: Request, api: HistoryApi): Promise<unknown> {
  const by = value.by === "path" ? "path" : "site";
  const span = visitSpan(value);
  if (span && inverted(span)) return { by, scanned: 0, groups: [] };
  const start = span ? span.since : startTime(value, 90);
  const endAt = span?.until !== undefined ? span.until + 1 : Date.now() + 1;
  const scanned = await scanAll(api, String(value.text ?? ""), start, endAt);
  const grouped = span
    ? await groupVisits(scanned.items, by, value, api, span)
    : { groups: groupTotals(scanned.items, by, value), truncated: false };
  return ranked(by, scanned, grouped, value, span !== undefined);
}

function ranked(
  by: string,
  scanned: { items: Item[]; truncated: boolean },
  grouped: { groups: Group[]; truncated: boolean },
  value: Request,
  windowed: boolean,
): unknown {
  const recent = value.sort === "recent";
  const ordered = [...grouped.groups].sort((left, right) =>
    recent ? right.last - left.last : right.visits - left.visits || right.last - left.last,
  );
  const truncated = scanned.truncated || grouped.truncated;
  return {
    by,
    scanned: scanned.items.length,
    ...(truncated ? { truncated: true } : {}),
    groups: ordered.slice(0, count(value.max, 25, 1000)).map((group) => groupView(group, windowed)),
  };
}

function groupView(group: Group, windowed: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = {
    key: group.key,
    visits: group.visits,
    pages: group.pages,
    lastVisit: group.last ? new Date(group.last).toISOString() : undefined,
    top: group.best ? { url: group.best.url, title: group.best.title } : undefined,
  };
  if (!windowed) return view;
  const times = [...group.times].sort((left, right) => right - left);
  view.times = isoTimes(times);
  if (group.timesTruncated || times.length > MAX_TIMES) view.timesTruncated = true;
  return view;
}

function count(value: unknown, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(1, Math.floor(number))) : fallback;
}
