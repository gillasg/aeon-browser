import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import { createBrowserCodeTool } from "./browser-code-tool.js";
import type { BrowserToolRunner } from "./browser-tool.js";
import { createCrawlTool } from "./crawl-tool.js";
import { createSiteApiTool } from "./site-api-tool.js";
import { inChat, sessionChatId } from "./site-browser.js";

// Tools for agents outside Aeon, through the Aeon MCP server: the same browser_code, crawl and
// site_api a chat gets, so another agent can do in Aeon everything the Browser Use Extension
// offers. Each outside session has its own browser runtime, tabs and workspace.

type Tool = ReturnType<typeof defineTool>;
type Content = { type: string; [key: string]: unknown };

export interface ExternalToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ExternalToolResult {
  content: Content[];
  isError: boolean;
}

const SESSION = {
  type: "string",
  maxLength: 100,
  description: "Session name: calls in one session share variables, tabs and files.",
};
const TABS_CODE =
  "(await browser.tabs()).map((tab) => ({ tabId: tab.target?.tabId, title: tab.title, url: tab.url, target: tab.target }))";

function toolsFor(
  directory: string,
  run: BrowserToolRunner | undefined,
  session: string,
): Record<string, Tool> {
  const chatId = sessionChatId("external", session);
  const workspace = resolve(directory, "..", "external", session.replace(/[^\w.-]+/g, "-"));
  const skills = resolve(directory, "..", "site-skills");
  return {
    browser_code: createBrowserCodeTool(chatId, run, workspace, skills),
    crawl: createCrawlTool(chatId, workspace),
    site_api: createSiteApiTool(chatId, workspace),
  };
}

const describe = (tool: Tool): string =>
  [tool.description, ...(tool.promptGuidelines ?? [])].join("\n\n");

export function externalToolDefinitions(
  directory: string,
  run: BrowserToolRunner | undefined,
): ExternalToolDefinition[] {
  const tools = toolsFor(directory, run, "default");
  const withSession = (tool: Tool) => {
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as {
      properties: Record<string, unknown>;
    };
    return { ...schema, properties: { ...schema.properties, session: SESSION } };
  };
  return [
    ...Object.values(tools).map((tool) => ({
      name: tool.name,
      description: describe(tool),
      inputSchema: withSession(tool),
    })),
    {
      name: "browser_tabs",
      description:
        "List the open tabs of the user's Chrome, with the target to pass to browser.attachTab() in browser_code.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION },
        additionalProperties: false,
      },
    },
  ];
}

export async function runExternalTool(
  directory: string,
  run: BrowserToolRunner | undefined,
  name: string,
  session: string,
  args: Record<string, unknown>,
): Promise<ExternalToolResult> {
  const tools = toolsFor(directory, run, session);
  const tool = name === "browser_tabs" ? tools.browser_code : tools[name];
  if (!tool) throw new Error(`Unknown tool ${name}`);
  const input = name === "browser_tabs" ? { code: TABS_CODE } : args;
  const workspace = resolve(directory, "..", "external", session.replace(/[^\w.-]+/g, "-"));
  await mkdir(workspace, { recursive: true });
  const result = await inChat(sessionChatId("external", session), () =>
    tool.execute(randomUUID(), input as never, undefined, undefined, undefined as never),
  );
  const outcome = result as unknown as { content: Content[]; isError?: boolean };
  return { content: outcome.content, isError: outcome.isError === true };
}
