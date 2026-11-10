import { resolve } from "node:path";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrowserNameProvider } from "./browser-code-tool.js";
import { createBrowserTools } from "./browser-code-tool.js";
import type { SiteRulesProvider } from "./browser-host-requests.js";
import type { BrowserToolRunner } from "./browser-tool.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { createCapabilityTools, type CapabilityToolHost } from "./capability-tools.js";
import { createClockTool } from "./clock-tool.js";
import { createCrawlTool } from "./crawl-tool.js";
import { createExtractTool } from "./extract-tool.js";
import { createSiteMapperTool } from "./site-mapper-tool.js";
import { fastToolModel, siteToolModel, type CompletionOptions } from "./text-completion.js";
import { createThreadTools, type ThreadToolHost } from "./thread-tools.js";

export interface ChatToolInput {
  chatId: string;
  workingDirectory: string;
  sessionDirectory: string;
  completion: CompletionOptions;
  browserTool?: BrowserToolRunner | undefined;
  threadToolHost?: ThreadToolHost | undefined;
  capabilityToolHost?: CapabilityToolHost | undefined;
  siteRules?: SiteRulesProvider | undefined;
  browserName?: BrowserNameProvider | undefined;
}

/** The tools a new chat registers. The session opener and the agent-surface export both use this. */
export function createChatTools(input: ChatToolInput): ReturnType<typeof defineTool>[] {
  const browserOptions = {
    ...(input.siteRules ? { siteRules: input.siteRules } : {}),
    ...(input.browserName ? { browserName: input.browserName } : {}),
    model: fastToolModel(input.completion),
  };
  return [
    ...createBrowserTools(
      input.chatId,
      input.browserTool,
      input.workingDirectory,
      resolve(input.sessionDirectory, "..", "site-skills"),
      browserOptions,
    ),
    ...createThreadTools(input.chatId, input.threadToolHost),
    ...createCapabilityTools(input.chatId, input.capabilityToolHost),
    createClockTool(),
    createSiteMapperTool(input.chatId, input.workingDirectory, siteToolModel(input.completion)),
    createCrawlTool(input.chatId, input.workingDirectory, siteToolModel(input.completion)),
    createExtractTool(input.completion, input.workingDirectory),
    createAskUserTool(input.chatId),
  ];
}
