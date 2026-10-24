import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  siteMapperTool,
  toolSchema,
  type SiteMapperToolInput,
} from "@browserkit/tools/definitions";
import { SITE_TOOL_ACTIONS, SITE_TOOL_HELP, type ModelLike } from "@browserkit/tools/site-to-api";
import { inChat } from "./site-browser.js";
import { boundedResult, errorResult, textResult, type ToolText } from "./site-tool-output.js";

// site_mapper: the actions and parameters come from browserkit's definition. Aeon adds chat
// context, the chat workspace, a model and bounded previews; its allow-list keeps every browserkit
// action that is not listed here off.

export const SITE_MAPPER_ACTIONS = [
  "sites",
  "operations",
  "call",
  "import",
  "watch",
  "explore",
  ...SITE_TOOL_ACTIONS,
] as const;

const Parameters = Type.Unsafe<SiteMapperToolInput>(
  toolSchema(siteMapperTool, SITE_MAPPER_ACTIONS) as never,
);

const GUIDELINES = [
  "Sites learn their APIs while you work: every page action's requests are built into the site's API after each browser_code call, and the call's output says when something new can be called ('Learned on <site>: ...'). Check `sites` / `operations` before working on a site you have used before; one call replaces many page actions.",
  "Reads go through `call` here or siteMapper.call in browser_code. Writes: do one in the page; once it worked, siteMapper.write repeats it and siteMapper.batch runs it over many items (paced, stops at the first error; continue what is left in the page). Paying, ordering, sending, posting, deleting and account changes always stay in the page.",
  "watch: like call, but returns only items new or changed since the last watch of the same operation and params; the first returns first: true. Pair it with a routine to check on a schedule. key names the field that identifies an item when the default (id, url, ...) is wrong.",
  "explore maps sites you have not used yet (sites: ['a.com']) in background tabs, looking only. The system runs it when a routine or watcher needs a site with no read that fits; use it yourself only when a task needs a part of a site that no page you can reach shows. It is heavy (an agent with its own tabs per site): explore one site at a time, and for sites built on the same code explore one, then call its learned API on the rest. Many pages or sites: browser.job (or crawl for plain reads), never one long cell.",
  "import adds capture files from outside the browser (HAR exports, mitmproxy flows from phone or desktop apps, saved in the workspace) to a site's API.",
  ...SITE_TOOL_HELP,
  "Long results are saved in the workspace and previewed; load the file in browser_code or read it with other tools if you need all of it.",
];

function siteOf(input: SiteMapperToolInput): string {
  return input.site ?? input.name ?? "site";
}

function label(input: SiteMapperToolInput): string {
  const site = siteOf(input);
  return input.operation ? `${site}-${input.action}-${input.operation}` : `${site}-${input.action}`;
}

async function runAction(
  input: SiteMapperToolInput,
  workspace: string | undefined,
  model?: () => Promise<ModelLike>,
): Promise<ToolText> {
  const context = { ...(workspace ? { workspace } : {}), ...(model ? { model } : {}) };
  const result = await siteMapperTool.run(input, context);
  if (input.action === "explore" || input.action === "operations" || input.action === "import")
    return textResult(result);
  if (input.action === "sites") {
    const siteResult = result as { sites: unknown[] };
    return textResult(
      siteResult.sites.length
        ? result
        : {
            ...siteResult,
            next: "Nothing is mapped yet. Sites you use in browser_code are learned as you go.",
          },
    );
  }
  return boundedResult(result, workspace, "site-mapper", label(input));
}

export function createSiteMapperTool(
  chatId: string,
  workspace?: string,
  model?: () => Promise<ModelLike>,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: siteMapperTool.name,
    label: "Site API",
    description: siteMapperTool.description,
    promptSnippet: "Use site_mapper for mapped sites: one API call instead of many page actions.",
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
