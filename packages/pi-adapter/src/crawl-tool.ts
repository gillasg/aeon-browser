import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_CRAWL_ACTIONS,
  crawlTool,
  toolSchema,
  type CrawlToolInput,
} from "@browserkit/tools/definitions";
import { writeOutput, type ModelLike, type PageResult } from "@browserkit/tools/browser-crawl";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inChat } from "./site-browser.js";
import { runCheck } from "./crawl-check.js";
import { boundedResult, errorResult, textResult, type ToolText } from "./site-tool-output.js";

// crawl: read pages and whole sites as Markdown and data. The actions and parameters come from
// browserkit's definition; Aeon only saves results, scopes the browser call to the chat, and
// keeps check's workspace evidence.

export const CRAWL_ACTIONS = AGENT_CRAWL_ACTIONS;

const Parameters = Type.Unsafe<CrawlToolInput>(
  toolSchema(crawlTool, CRAWL_ACTIONS, ["api"]) as never,
);

const GUIDELINES = [
  "crawl reads pages without driving tabs step by step: scrape one URL, crawl a site or a section (include ['/docs/**']), map a site's URLs, or search the web (engine auto: Google in the user's browser for local, live and personal queries, fast keyless providers for the rest). Pages behind the user's logins work: they are fetched in their browser when plain HTTP is not enough.",
  "Prefer crawl over browser_code to read or collect content from many pages; use browser_code to act on pages (click, fill, buy). When webfetch fails (blocked shops, ticketing and travel sites, pages built by JavaScript), use crawl scrape instead of retrying webfetch: it switches to the user's browser.",
  "This computer runs Windows and bash has no python: process data in browser_code, or with node in bash.",
  "check tells which of many sites load (urls: hosts or URLs, or file: a workspace file listing them, up to 5000): plain HTTP first, then the user's Chrome for anything refused, challenged or blocked, four pages at a time, with a few successes re-checked; via 'http' never starts Chrome. The reply says chromePages. Every verdict (ok, js-shell, challenge, login, blocked, rate-limited, server-error, not-found, parked, dead, refused, redirected, origin-gated) is saved with its evidence. Give paths (['/api/x', '/stream.m3u8']) to probe the same paths on every host, and expect (json, html, m3u8, xml, text) to check the content type and the body's real shape: a JSON endpoint on one site and another site's HTML catch-all answering 200 are told apart. Use it instead of writing your own probe script; report its counts with the spotCheck line, and look at a few results in a real tab before drawing conclusions.",
  "find builds a list from the web: query, criteria (what every row must be) and columns ({founded: 'year founded'}); it searches, reads each result, keeps matches and fills the columns, with each row's source page.",
  "Give a query to rank pages by relevance and get fitMarkdown (only the relevant parts). Whole crawls are saved in the workspace as Markdown files plus pages.jsonl; the reply lists them with short previews.",
];

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

async function saveCrawl(pages: PageResult[], workspace: string | undefined): Promise<ToolText> {
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
      results: pages.map((page) => preview(page, 300)),
    },
    workspace,
    "crawls",
    "summary",
  );
}

async function runAction(
  input: CrawlToolInput,
  workspace: string | undefined,
  model?: () => Promise<ModelLike>,
): Promise<ToolText> {
  if (input.action === "check") return runCheck(input, workspace);
  const value = await crawlTool.run(input, { ...(model ? { model } : {}) });
  if (input.action === "crawl") return saveCrawl(value as PageResult[], workspace);
  if (input.action === "scrape")
    return boundedResult(value, workspace, "crawls", new URL((value as PageResult).url).hostname);
  if (input.action === "map") return boundedResult(value, workspace, "crawls", "map");
  if (input.action === "find") return boundedResult(value, workspace, "crawls", "find");
  return textResult(value);
}

export function createCrawlTool(
  chatId: string,
  workspace?: string,
  model?: () => Promise<ModelLike>,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: crawlTool.name,
    label: "Crawl",
    description: crawlTool.description,
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
