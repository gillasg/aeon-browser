import { SiteScriptDefinitionSchema, type SiteScriptDefinition } from "@pippin/protocol";
export const SCRIPT_KEY = "aeon-site-scripts";
export function readScripts(value: unknown): SiteScriptDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = SiteScriptDefinitionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}
