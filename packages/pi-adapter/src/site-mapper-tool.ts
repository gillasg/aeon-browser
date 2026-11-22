import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_SITE_MAPPER_ACTIONS,
  siteMapperTool,
  toolSchema,
  type SiteMapperToolInput,
} from "@browserkit/tools/definitions";
import { SITE_TOOL_HELP, type ModelLike } from "@browserkit/tools/site-to-api";
import { inChat } from "./site-browser.js";
import { boundedResult, errorResult, textResult, type ToolText } from "./site-tool-output.js";

// site_mapper: the actions and parameters come from browserkit's definition. Aeon adds chat
// context, the chat workspace, a model and bounded previews; its allow-list keeps every browserkit
// action that is not listed here off.

export const SITE_MAPPER_ACTIONS = AGENT_SITE_MAPPER_ACTIONS;

const Parameters = Type.Unsafe<SiteMapperToolInput>(
  toolSchema(siteMapperTool, SITE_MAPPER_ACTIONS) as never,
);

const GUIDELINES = [
  "Sites learn their APIs while you work: every page action's requests are built into the site's API after each browser_code call, and the call's output says when something new can be called ('Learned on <site>: ...').",
  "In browser_code, `[api]` reads are siteMapper.call and `[saved]` abilities site.run. Writes: do one in the page; once it worked, siteMapper.write repeats it and siteMapper.batch runs it over many items (paced, stops at the first error; continue what is left in the page). Paying, ordering, sending, posting, deleting and account changes always stay in the page.",
  "watch: like call, but returns only items new or changed since the last watch of the same operation and params; the first returns first: true. Pair it with a routine to check on a schedule. key names the field that identifies an item when the default (id, url, ...) is wrong.",
  "explore maps sites you have not used yet (sites: ['a.com']) in background tabs, looking only. The system runs it when a routine or watcher needs a site with no read that fits; use it yourself only when a task needs a part of a site that no page you can reach shows. It is heavy (an agent with its own tabs per site): explore one site at a time, and for sites built on the same code explore one, then call its learned API on the rest. Many pages or sites: browser.job (or crawl for plain reads), never one long cell.",
  "import adds capture files from outside the browser (HAR, mitmproxy flows from phone or desktop apps) to a site's API, or installs a saved site pack (its .zip or extracted folder, in the workspace; the pack names its site) with its abilities.",
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

function repairedVersionOf(record: Record<string, unknown> | undefined): number | undefined {
  const healed =
    record?.healed && typeof record.healed === "object"
      ? (record.healed as { toVersion?: unknown })
      : undefined;
  const version = healed?.toVersion ?? record?.toVersion;
  return typeof version === "number" && Number.isInteger(version) && version > 0
    ? version
    : undefined;
}

function abilityProof(
  action: "action" | "heal",
  site: string | undefined,
  result: unknown,
): Record<string, unknown> | undefined {
  const record =
    result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
  const repairedVersion = repairedVersionOf(record);
  if (action === "heal") {
    return repairedVersion ? { repairedVersion, ...(site ? { site } : {}) } : undefined;
  }
  const proof: Record<string, unknown> = { usedAbility: true };
  if (record?.compiled === true) {
    proof.usedApi = true;
    proof.compiled = true;
  }
  if (repairedVersion) proof.repairedVersion = repairedVersion;
  if (site) proof.site = site;
  return proof;
}

function proofForAction(
  input: SiteMapperToolInput,
  result: unknown,
): Record<string, unknown> | undefined {
  const site = typeof input.site === "string" && input.site.trim() ? input.site.trim() : undefined;
  if (input.action === "call" || input.action === "watch") {
    return site ? { usedApi: true, site } : { usedApi: true };
  }
  if (input.action === "action" || input.action === "heal") {
    return abilityProof(input.action, site, result);
  }
  return undefined;
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
  const output = await boundedResult(result, workspace, "site-mapper", label(input));
  const proof = proofForAction(input, result);
  return proof ? { ...output, details: { ...(output.details ?? {}), proof } } : output;
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
