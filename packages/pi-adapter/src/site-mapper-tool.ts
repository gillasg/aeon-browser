import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  checkCaptures,
  explore,
  isSiteToolAction,
  runSiteToolAction,
  SITE_TOOL_ACTIONS,
  SITE_TOOL_HELP,
  importCaptures,
  listSites,
  loadModel,
  rebuild,
  siteMapper,
  siteName,
  watch,
  type ModelLike,
} from "@browserkit/tools/site-to-api";
import { inChat } from "./site-browser.js";
import { boundedResult, errorResult, textResult, type ToolText } from "./site-tool-output.js";

// site_mapper: sites mapped with site-to-api become APIs the agent calls directly, with the user's
// logins, instead of clicking through pages. Mapping happens from network captures the agent
// saves while using a site in browser_code.

const Parameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("sites"),
      Type.Literal("operations"),
      Type.Literal("call"),
      Type.Literal("import"),
      Type.Literal("watch"),
      Type.Literal("explore"),
      ...SITE_TOOL_ACTIONS.map((action) => Type.Literal(action)),
    ]),
    name: Type.Optional(Type.String({ maxLength: 200 })),
    steps: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    change: Type.Optional(Type.String({ maxLength: 4000 })),
    folder: Type.Optional(Type.String({ maxLength: 500 })),
    repair: Type.Optional(Type.Boolean()),
    actions: Type.Optional(Type.Boolean()),
    site: Type.Optional(Type.String({ maxLength: 200 })),
    operation: Type.Optional(Type.String({ maxLength: 200 })),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    transport: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("page"), Type.Literal("direct")]),
    ),
    files: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
    sites: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 10 })),
    goal: Type.Optional(Type.String({ maxLength: 2000 })),
    key: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);
type Input = Static<typeof Parameters>;

const GUIDELINES = [
  "Sites learn their APIs while you work: every page action's requests are built into the site's API after each browser_code call, and the call's output says when something new can be called ('Learned on <site>: ...'). Check `sites` / `operations` before working on a site you have used before; one call replaces many page actions.",
  "Reads go through `call` here or siteMapper.call in browser_code. Writes: do one in the page; once it worked, siteMapper.write repeats it and siteMapper.batch runs it over many items (paced, stops at the first error; continue what is left in the page). Paying, ordering, sending, posting, deleting and account changes always stay in the page.",
  "watch: like call, but returns only items new or changed since the last watch of the same operation and params; the first returns first: true. Pair it with a routine to check on a schedule. key names the field that identifies an item when the default (id, url, ...) is wrong.",
  "explore maps sites you have not used yet (sites: ['a.com']) in background tabs, looking only. The system runs it when a routine or watcher needs a site with no read that fits; use it yourself only when a task needs a part of a site that no page you can reach shows.",
  "import adds capture files from outside the browser (HAR exports, mitmproxy flows from phone or desktop apps, saved in the workspace) to a site's API.",
  ...SITE_TOOL_HELP,
  "Long results are saved in the workspace and previewed; load the file in browser_code or read it with other tools if you need all of it.",
];

function requireSite(input: Input): string {
  // Models often pass the site as `name`; outside the name action that can only mean the site.
  const site = input.site ?? ((input.action as string) !== "name" ? input.name : undefined);
  if (!site) throw new Error("Give the site, for example shop.example.com");
  return siteName(site);
}

const HOW_TO_CALL =
  "Pass params flat: path and query parameters and top-level body fields by name, for example {query: 'shoes', page: 2}. Every required parameter must be passed; nothing is filled from the recording. Use body: {...} to pass deeper body fields.";

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
  if (!model)
    throw new Error(
      `${site} has no API yet. Use the site in browser_code: its requests are learned as you go.`,
    );
  return { site, howToCall: HOW_TO_CALL, operations: model.operations.map(describeOperation) };
}

async function call(input: Input, workspace: string | undefined): Promise<ToolText> {
  const site = requireSite(input);
  if (!input.operation) throw new Error("Give the operation id (see the operations action)");
  const api = await siteMapper(site, { transport: input.transport ?? "auto" });
  const value = await api.call(input.operation, (input.params ?? {}) as never);
  return boundedResult(value, workspace, "site-mapper", `${site}-${input.operation}`);
}

async function importFiles(input: Input, workspace: string | undefined): Promise<unknown> {
  const site = requireSite(input);
  if (!workspace) throw new Error("This chat has no workspace for captures");
  if (!input.files?.length)
    throw new Error(
      "import needs capture files in the workspace (a HAR export or mitmproxy flows). Sites you use in browser_code are learned without it.",
    );
  const paths = input.files.map((file) => resolve(workspace, file));
  if (paths.some((path) => !path.startsWith(resolve(workspace))))
    throw new Error("Capture files must be inside the workspace");
  await checkCaptures(paths).catch((error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Give a HAR export or mitmproxy flow file of the site's own requests.`,
      { cause: error },
    );
  });
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

async function watchAction(input: Input, workspace: string | undefined): Promise<ToolText> {
  const site = requireSite(input);
  if (!input.operation)
    throw new Error("Give the operation id to watch (see the operations action)");
  const result = await watch(site, input.operation, (input.params ?? {}) as never, {
    transport: input.transport ?? "auto",
    ...(input.key ? { key: input.key } : {}),
  });
  return boundedResult(result, workspace, "site-mapper", `${site}-watch-${input.operation}`);
}

async function exploreAction(input: Input, model?: () => Promise<ModelLike>): Promise<ToolText> {
  const sites = input.sites?.length ? input.sites : input.site ? [input.site] : [];
  if (!sites.length) throw new Error("Give sites: the names or URLs of the sites to map");
  const results = await explore(sites, {
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.actions ? { actions: true } : {}),
    ...(model ? { model: await model() } : {}),
  });
  return textResult({ howToCall: HOW_TO_CALL, results });
}

async function runAction(
  input: Input,
  workspace: string | undefined,
  model?: () => Promise<ModelLike>,
): Promise<ToolText> {
  if (input.action === "watch") return watchAction(input, workspace);
  if (isSiteToolAction(input.action))
    return boundedResult(
      await runSiteToolAction(input.action, {
        ...input,
        site: requireSite(input),
        ...(input.folder && workspace ? { folder: resolve(workspace, input.folder) } : {}),
      }),
      workspace,
      "site-mapper",
      `${requireSite(input)}-${input.action}`,
    );
  if (input.action === "explore") return exploreAction(input, model);
  if (input.action === "sites") {
    const sites = await listSites();
    return textResult(
      sites.length
        ? { sites }
        : {
            sites,
            next: "Nothing is mapped yet. Sites you use in browser_code are learned as you go.",
          },
    );
  }
  if (input.action === "operations") return textResult(await operations(input));
  if (input.action === "call") return call(input, workspace);
  return textResult(await importFiles(input, workspace));
}

export function createSiteMapperTool(
  chatId: string,
  workspace?: string,
  model?: () => Promise<ModelLike>,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "site_mapper",
    label: "Site API",
    description:
      "Call the API a site learned while you used it (actions: sites, operations, call, watch, action, channel), see its published docs, keep it working (heal, coverage, edit, name, signing, session, export), or map sites you haven't used: by name (explore) or from capture files (import). Calls use the user's logins.",
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
