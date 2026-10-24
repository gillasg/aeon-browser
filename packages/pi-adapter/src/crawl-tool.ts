import { Type, type Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  crawl,
  findList,
  mapSite,
  scrape,
  search,
  writeOutput,
  type Format,
  type ModelLike,
  type PageResult,
} from "@browserkit/tools/browser-crawl";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inChat } from "./site-browser.js";
import { runCheck } from "./crawl-check.js";
import { boundedResult, errorResult, textResult, type ToolText } from "./site-tool-output.js";

// crawl: read pages and whole sites as Markdown and data. Plain HTTP first, the user's own
// browser for pages that need JavaScript or a login, and mapped site APIs when they exist.

const FORMATS = [
  "markdown",
  "fitMarkdown",
  "text",
  "links",
  "metadata",
  "tables",
  "pageData",
  "product",
] as const;

const Parameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("scrape"),
      Type.Literal("crawl"),
      Type.Literal("map"),
      Type.Literal("search"),
      Type.Literal("find"),
      Type.Literal("check"),
    ]),
    columns: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 300 }))),
    criteria: Type.Optional(Type.String({ maxLength: 1000 })),
    url: Type.Optional(Type.String({ maxLength: 2000 })),
    urls: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 5000 })),
    file: Type.Optional(Type.String({ maxLength: 500 })),
    query: Type.Optional(Type.String({ maxLength: 500 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    include: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
    exclude: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
    formats: Type.Optional(
      Type.Array(Type.Union(FORMATS.map((f) => Type.Literal(f))), { maxItems: 8 }),
    ),
    render: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("static"), Type.Literal("browser")]),
    ),
  },
  { additionalProperties: false },
);
type Input = Static<typeof Parameters>;

const GUIDELINES = [
  "crawl reads pages without driving tabs step by step: scrape one URL, crawl a site or a section (include ['/docs/**']), map a site's URLs, or search Google. Pages behind the user's logins work: they are fetched in their browser when plain HTTP is not enough.",
  "Prefer crawl over browser_code to read or collect content from many pages; use browser_code to act on pages (click, fill, buy). When webfetch fails (blocked shops, ticketing and travel sites, pages built by JavaScript), use crawl scrape instead of retrying webfetch: it switches to the user's browser.",
  "This computer runs Windows and bash has no python: process data in browser_code, or with node in bash.",
  "check tells which of many sites load (urls: hosts or URLs, or file: a workspace file listing them, up to 5000): plain HTTP first, then the user's Chrome for anything refused, challenged or blocked, with a few successes re-checked in Chrome; every verdict (ok, js-shell, challenge, login, blocked, rate-limited, server-error, not-found, parked, dead, refused) is saved with its evidence. Use it instead of writing your own probe script; report its counts with the spotCheck line, and look at a few results in a real tab before drawing conclusions.",
  "find builds a list from the web: query, criteria (what every row must be) and columns ({founded: 'year founded'}); it searches, reads each result, keeps matches and fills the columns, with each row's source page.",
  "Give a query to rank pages by relevance and get fitMarkdown (only the relevant parts). Whole crawls are saved in the workspace as Markdown files plus pages.jsonl; the reply lists them with short previews.",
];

function requireUrl(input: Input): string {
  if (!input.url) throw new Error("Give the url");
  return input.url;
}

const formatsOf = (input: Input): Format[] =>
  (input.formats as Format[] | undefined) ??
  (input.query ? ["fitMarkdown", "metadata"] : ["markdown", "metadata"]);

function preview(page: PageResult, chars = 600): Record<string, unknown> {
  const text = page.fitMarkdown ?? page.markdown ?? page.text ?? "";
  return {
    url: page.finalUrl ?? page.url,
    status: page.status,
    title: page.title,
    ...(page.error ? { error: page.error } : {}),
    preview: text.slice(0, chars),
  };
}

async function runCrawl(input: Input, workspace: string | undefined): Promise<ToolText> {
  const pages = await crawl({
    url: requireUrl(input),
    limit: input.limit ?? 25,
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
    ...(input.include ? { include: input.include } : {}),
    ...(input.exclude ? { exclude: input.exclude } : {}),
    ...(input.query ? { query: input.query, strategy: "best" as const } : {}),
    formats: formatsOf(input),
    render: input.render ?? "auto",
  });
  let saved: string | undefined;
  if (workspace && pages.length) {
    const folder = join("crawls", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(join(workspace, folder), { recursive: true });
    await writeOutput(pages, join(workspace, folder));
    saved = folder.replace(/\\/g, "/");
  }
  return boundedResult(
    {
      pages: pages.length,
      ...(saved ? { savedIn: saved } : {}),
      results: pages.map((p) => preview(p, 300)),
    },
    workspace,
    "crawls",
    "summary",
  );
}

async function find(
  query: string,
  input: Input,
  workspace: string | undefined,
  model?: () => Promise<ModelLike>,
): Promise<ToolText> {
  const rows = await findList(query, {
    columns: input.columns ?? { name: "name" },
    ...(input.criteria ? { criteria: input.criteria } : {}),
    perQuery: input.limit ?? 10,
    ...(model ? { model: await model() } : {}),
  });
  return boundedResult(rows, workspace, "crawls", "find");
}

async function runAction(
  input: Input,
  workspace: string | undefined,
  model?: () => Promise<ModelLike>,
): Promise<ToolText> {
  if (input.action === "scrape") {
    const page = await scrape(requireUrl(input), {
      formats: formatsOf(input),
      render: input.render ?? "auto",
      ...(input.query ? { query: input.query } : {}),
    });
    return boundedResult(page, workspace, "crawls", new URL(page.url).hostname);
  }
  if (input.action === "crawl") return runCrawl(input, workspace);
  if (input.action === "check") return runCheck(input, workspace);
  if (input.action === "map") {
    const urls = await mapSite(requireUrl(input), {
      limit: input.limit ?? 500,
      ...(input.query ? { search: input.query } : {}),
    });
    return boundedResult(urls, workspace, "crawls", "map");
  }
  if (!input.query) throw new Error("Give the query to search for");
  if (input.action === "find") return find(input.query, input, workspace, model);
  return textResult(await search(input.query, { limit: input.limit ?? 10 }));
}

export function createCrawlTool(
  chatId: string,
  workspace?: string,
  model?: () => Promise<ModelLike>,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "crawl",
    label: "Crawl",
    description:
      "Read web pages as Markdown and data: scrape a URL, crawl a site or section, map a site's URLs, check which of many sites load, or search Google. Uses plain HTTP first and the user's browser (with their logins) when needed.",
    promptSnippet: "Use crawl to read or collect content from pages and whole sites.",
    promptGuidelines: GUIDELINES,
    parameters: Parameters,
    execute: async (_toolCallId, input) => {
      try {
        return await inChat(chatId, () => runAction(input, workspace, model));
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
