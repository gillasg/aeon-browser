import {
  catalogToolsForSite,
  listAbilities,
  listSites,
  loadModel,
  runAbility,
  searchCatalog,
  structuredOutput,
  type CatalogTool,
} from "@browserkit/tools/site-to-api";
import { siteMapper } from "@browserkit/tools/site-to-api/runtime";

export type { CatalogTool };

/** Mapped operations and saved abilities, one stable tool name each. */
export async function loadCatalog(): Promise<CatalogTool[]> {
  const sites = await listSites().catch(() => []);
  const taken = new Set<string>();
  const tools: CatalogTool[] = [];
  for (const entry of sites) {
    const [model, abilities] = await Promise.all([
      loadModel(entry.site).catch(() => undefined),
      listAbilities(entry.site).catch(() => []),
    ]);
    tools.push(...catalogToolsForSite(entry.site, model, abilities, taken));
  }
  return tools;
}

export function catalogFingerprint(
  tools: readonly {
    name: string;
    description: string;
    inputSchema?: unknown;
    annotations?: unknown;
  }[],
): string {
  // Schema and annotations count too: a re-saved ability with new inputs is a changed tool.
  return tools
    .map((tool) =>
      [
        tool.name,
        tool.description,
        JSON.stringify(tool.inputSchema ?? null),
        JSON.stringify(tool.annotations ?? null),
      ].join("\n"),
    )
    .join("\n");
}

export function catalogMcpTool(tool: CatalogTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}

/** Runs a catalog tool and answers with its MCP result (text, plus structuredContent). */
export async function callCatalogResult(
  name: string,
  args: Record<string, unknown>,
  tools: readonly CatalogTool[],
): Promise<Record<string, unknown>> {
  return catalogCallResult(name, await callCatalog(name, args, tools), tools);
}

/** A catalog call's MCP result: the JSON as text, plus `structuredContent` when declared. */
export function catalogCallResult(
  name: string,
  value: unknown,
  tools: readonly CatalogTool[],
): Record<string, unknown> {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema;
  const structured = schema ? structuredOutput(value, schema) : undefined;
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    ...(structured ? { structuredContent: structured } : {}),
    isError: false,
  };
}

/** `catalog_search`, or `site__…` runs that operation or ability. */
export async function callCatalog(
  name: string,
  args: Record<string, unknown>,
  cached?: readonly CatalogTool[],
): Promise<unknown> {
  const tools = cached && cached.length ? cached : await loadCatalog();
  if (name === "catalog_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query is required");
    return searchCatalog([...tools], query).map((tool) => ({
      name: tool.name,
      description: tool.description,
      effect: tool.effect,
      inputSchema: tool.inputSchema,
    }));
  }
  const tool =
    tools.find((item) => item.name === name) ??
    (await loadCatalog()).find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  if (tool.kind === "ability") {
    const run = await runAbility(tool.site, tool.id, args);
    return { result: run.result, via: run.via };
  }
  return (await siteMapper(tool.site)).call(tool.id, args);
}
