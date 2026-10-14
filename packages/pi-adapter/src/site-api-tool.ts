import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { importCaptures, listSites, loadModel, rebuild, siteApi, siteName } from "site-to-api";
import { inChat } from "./site-browser.js";
import { boundedResult, errorResult, textResult, type ToolText } from "./site-tool-output.js";

// site_api: sites mapped with site-to-api become APIs the agent calls directly, with the user's
// logins, instead of clicking through pages. Mapping happens from network captures the agent
// saves while using a site in browser_code.

const Parameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("sites"),
      Type.Literal("operations"),
      Type.Literal("call"),
      Type.Literal("learn"),
    ]),
    site: Type.Optional(Type.String({ maxLength: 200 })),
    operation: Type.Optional(Type.String({ maxLength: 200 })),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    transport: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("page"), Type.Literal("direct")]),
    ),
    files: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
  },
  { additionalProperties: false },
);
type Input = Static<typeof Parameters>;

const GUIDELINES = [
  "site_api calls the APIs of sites mapped from the user's own browsing: one call replaces many page actions and returns clean JSON. Check `sites` before working on a site you may have mapped; if it is there, use `operations` then `call` instead of browser_code.",
  "Calls run with the user's logins (through the site's own page when the API needs it), so treat writes (role action) like clicking the button: only when the user asked for that action.",
  "To map a site you will use again (prices, orders, listings, a dashboard): in browser_code start `await page.network.start({ types: 'all' })`, do the task, then `await artifact('<site>.har', JSON.stringify(await page.network.har()))`, then call site_api with action learn, the site and files ['<site>.har']. More captures of other features make the API more complete.",
  "Long results are saved in the workspace and previewed; load the file in browser_code or read it with other tools if you need all of it.",
];

function requireSite(input: Input): string {
  if (!input.site) throw new Error("Give the site, for example shop.example.com");
  return siteName(input.site);
}

const HOW_TO_CALL =
  "Pass params flat: path and query parameters and top-level body fields by name, for example {query: 'shoes', page: 2}. Anything left out keeps the value recorded from the site. Use body: {...} to merge deeper body fields.";

type SiteOperation = NonNullable<Awaited<ReturnType<typeof loadModel>>>["operations"][number];

/** Top-level body fields with the value the site last sent, so the model sees what each holds. */
function bodyFields(op: SiteOperation): Record<string, unknown> | undefined {
  const properties = Object.keys(
    (op.requestBody?.schema.properties as Record<string, unknown> | undefined) ?? {},
  );
  if (!properties.length) return undefined;
  let sample: Record<string, unknown> = {};
  try {
    sample = JSON.parse(op.samples.at(-1)?.requestBody ?? "{}") as Record<string, unknown>;
  } catch {
    /* a form or text body: names only */
  }
  return Object.fromEntries(
    properties.slice(0, 25).map((name) => {
      const value = JSON.stringify(sample[name] ?? null);
      return [name, value.length > 60 ? value.slice(0, 60) + "…" : JSON.parse(value)];
    }),
  );
}

function describeOperation(op: SiteOperation): Record<string, unknown> {
  const body = bodyFields(op);
  return {
    id: op.id,
    what: op.summary,
    method: op.method,
    path: op.path,
    role: op.role,
    params: op.params
      .filter((p) => !p.constant && !p.generated)
      .map((p) => `${p.name}${p.required ? "" : "?"}`),
    ...(body ? { bodyFields: body } : {}),
    ...(op.pagination ? { paginated: true } : {}),
  };
}

async function operations(input: Input): Promise<unknown> {
  const site = requireSite(input);
  const model = await loadModel(site);
  if (!model) throw new Error(`${site} is not mapped yet. Map it with the learn action.`);
  return { site, howToCall: HOW_TO_CALL, operations: model.operations.map(describeOperation) };
}

async function call(input: Input, workspace: string | undefined): Promise<ToolText> {
  const site = requireSite(input);
  if (!input.operation) throw new Error("Give the operation id (see the operations action)");
  const api = await siteApi(site, { transport: input.transport ?? "auto" });
  const value = await api.call(input.operation, (input.params ?? {}) as never);
  return boundedResult(value, workspace, "site-api", `${site}-${input.operation}`);
}

async function learn(input: Input, workspace: string | undefined): Promise<unknown> {
  const site = requireSite(input);
  if (!workspace) throw new Error("This chat has no workspace for captures");
  if (!input.files?.length) throw new Error("Give the HAR files saved in the workspace");
  const paths = input.files.map((file) => resolve(workspace, file));
  if (paths.some((path) => !path.startsWith(resolve(workspace))))
    throw new Error("Capture files must be inside the workspace");
  await importCaptures(site, paths);
  const result = await rebuild(site);
  // The operations come back right away, so the next step can be a call.
  return {
    site,
    version: result.version,
    changed: result.changed,
    howToCall: HOW_TO_CALL,
    operations: result.model.operations.map(describeOperation),
  };
}

async function runAction(input: Input, workspace: string | undefined): Promise<ToolText> {
  if (input.action === "sites") return textResult({ sites: await listSites() });
  if (input.action === "operations") return textResult(await operations(input));
  if (input.action === "call") return call(input, workspace);
  return textResult(await learn(input, workspace));
}

export function createSiteApiTool(
  chatId: string,
  workspace?: string,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "site_api",
    label: "Site API",
    description:
      "Call the API of a site mapped from the user's browsing (actions: sites, operations, call), or map one from network captures saved in the workspace (learn). Calls use the user's logins.",
    promptSnippet: "Use site_api for mapped sites: one API call instead of many page actions.",
    promptGuidelines: GUIDELINES,
    parameters: Parameters,
    execute: async (_toolCallId, input) => {
      try {
        return await inChat(chatId, () => runAction(input, workspace));
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
