import { extractJson, type ModelLike } from "./extract/model.js";
import { searchAndScrape } from "./search.js";

// Find-and-fill: build a list from the web. Search, read each result, keep the ones that match the
// criteria, and fill in the columns for each, with the page each value came from:
//   await findList("seed-stage climate startups in India", {
//     criteria: "a company (not an article or list) that is seed stage",
//     columns: { name: "company name", founded: "year founded", funding: "latest round" },
//   })

export interface FindOptions {
  /** What every row must be, checked against each page. */
  criteria?: string;
  /** Column name → what to fill in. */
  columns: Record<string, string>;
  /** Extra searches to widen the list (the query itself is always searched). */
  queries?: string[];
  /** Search results to read per query (default 10). */
  perQuery?: number;
  model?: ModelLike;
  /** Chrome profile the page reads use. */
  browser?: string;
  /** Replaces web search in tests. */
  search?: FindSearch;
}

export interface FoundRow {
  url: string;
  values: Record<string, unknown>;
}

export interface RejectedPage {
  url: string;
  reason: string;
}

/** Rows, plus why a search that matched nothing opened the pages it did. */
export interface FindReport {
  rows: FoundRow[];
  opened: string[];
  rejected: RejectedPage[];
  why?: string;
}

export interface FindSearch {
  (
    query: string,
    options: {
      limit?: number;
      formats?: ("markdown" | "fitMarkdown" | "metadata")[];
      browser?: string;
    },
  ): Promise<{ url: string; page?: { fitMarkdown?: string; markdown?: string } }[]>;
}

const ROW_SCHEMA = (columns: Record<string, string>) => ({
  type: "object",
  properties: {
    matches: {
      type: "boolean",
      description: "Whether the page is about something that meets the criteria.",
    },
    rows: {
      type: "array",
      description: "One row per matching item on the page (a list page can have several).",
      items: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(columns).map(([name, what]) => [name, { description: what }]),
        ),
      },
    },
  },
  required: ["matches", "rows"],
});

function rowKey(values: Record<string, unknown>): string {
  const first = Object.values(values).find((value) => typeof value === "string" && value);
  return String(first ?? JSON.stringify(values))
    .toLowerCase()
    .trim();
}

type Found = { matches?: boolean; rows?: Record<string, unknown>[] } | undefined;

/** Reads one page: does it match, and the rows it holds. */
async function readPage(markdown: string, query: string, options: FindOptions): Promise<Found> {
  const criteria = options.criteria ? ` Every row must be: ${options.criteria}.` : "";
  return (await extractJson(
    markdown,
    {
      schema: ROW_SCHEMA(options.columns),
      prompt: `Building a list: ${query}.${criteria} Fill each column only from the page; null when the page does not say.`,
    },
    options.model,
  ).catch(() => undefined)) as Found;
}

function readResult(
  result: { page?: { fitMarkdown?: string; markdown?: string } },
  query: string,
  options: FindOptions,
): Promise<Found> {
  const markdown = result.page?.fitMarkdown ?? result.page?.markdown;
  return markdown ? readPage(markdown, query, options) : Promise.resolve(undefined);
}

function addRows(rows: Map<string, FoundRow>, url: string, found: Found): number {
  if (!found?.matches) return 0;
  let added = 0;
  for (const values of found.rows ?? []) {
    const key = rowKey(values);
    if (!rows.has(key)) {
      rows.set(key, { url, values });
      added += 1;
    }
  }
  return added;
}

type ListedPage = { url: string; page?: { fitMarkdown?: string; markdown?: string } };

async function considerPage(
  rows: Map<string, FoundRow>,
  opened: string[],
  rejected: RejectedPage[],
  result: ListedPage,
  query: string,
  options: FindOptions,
): Promise<void> {
  opened.push(result.url);
  const markdown = result.page?.fitMarkdown ?? result.page?.markdown;
  const found = markdown?.trim() ? await readResult(result, query, options) : undefined;
  const added = addRows(rows, result.url, found);
  const reason = rejectReason(markdown, found, added);
  if (reason) rejected.push({ url: result.url, reason });
}

function findReport(
  rows: Map<string, FoundRow>,
  opened: string[],
  rejected: RejectedPage[],
): FindReport {
  const kept = [...rows.values()];
  const why = opened.length ? "no page matched the criteria" : "no pages opened";
  return { rows: kept, opened, rejected, ...(kept.length ? {} : { why }) };
}

/** Why one opened page did not become a row. */
export function rejectReason(
  markdown: string | undefined,
  found: Found,
  added: number,
): string | undefined {
  if (!markdown?.trim()) return markdown === undefined ? "could not read the page" : "no page text";
  if (!found) return "could not read the page";
  if (!found.matches) return "did not match the criteria";
  if (!added) return "matched but added no new row";
  return undefined;
}

/** Searches, checks each result against the criteria, and fills in the columns. */
export async function findList(query: string, options: FindOptions): Promise<FindReport> {
  const rows = new Map<string, FoundRow>();
  const opened: string[] = [];
  const rejected: RejectedPage[] = [];
  const search = options.search ?? searchAndScrape;
  for (const term of [query, ...(options.queries ?? [])]) {
    const results = await search(term, {
      limit: options.perQuery ?? 10,
      formats: ["markdown"],
      ...(options.browser ? { browser: options.browser } : {}),
    });
    for (const result of results)
      await considerPage(rows, opened, rejected, result, query, options);
  }
  return findReport(rows, opened, rejected);
}
