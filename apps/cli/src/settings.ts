import type { AeonClient } from "./client.js";
import { readUseClientModel, writeUseClientModel } from "./mcp-sampling.js";

// `aeon settings`: read or change Aeon's agent settings in the connected Chrome. Screen recorders
// (Aeon Recorder) switch these on for a recording and restore them after; keep the names.
const FLAGS = ["agentInFront", "hideAgentCursor", "recordAgentTabs", "humanLikeInput"];
const VIEWS = ["auto", "split", "thumbnails"];
// mcpUseClientModel is Aeon's own setting, stored next to its data (no Chrome needed).
const LOCAL_FLAGS = ["mcpUseClientModel"];
type Setting = boolean | string;

export const settingsUsage = `  settings [get]                the agent settings in the connected Chrome
   settings set key=value ...    agentInFront=true|false hideAgentCursor=true|false
                                 recordAgentTabs=true|false
                                 humanLikeInput=true|false
                                 agentTabView=auto|split|thumbnails
                                 mcpUseClientModel=true|false
humanLikeInput is off by default (faster). Set it true, or AEON_HUMAN_INPUT=1, for a stealth run.
mcpUseClientModel prefers the calling agent's model for Aeon's own calls over MCP.`;

export async function settingsCommand(client: AeonClient, rest: string[]): Promise<number> {
  const [action = "get", ...pairs] = rest;
  if (action !== "get" && action !== "set") throw new Error(settingsUsage);
  const set = action === "set" ? parsePairs(pairs) : {};
  const local = filter(set, (key) => LOCAL_FLAGS.includes(key));
  const extension = filter(set, (key) => !LOCAL_FLAGS.includes(key));
  await storeLocal(local);
  if (
    (action === "get" || Object.keys(extension).length) &&
    !(await sendExtension(client, extension))
  )
    return 1;
  await reportLocal(action, local);
  return 0;
}

function filter(
  set: Record<string, Setting>,
  keep: (key: string) => boolean,
): Record<string, Setting> {
  return Object.fromEntries(Object.entries(set).filter(([key]) => keep(key)));
}

async function storeLocal(local: Record<string, Setting>): Promise<void> {
  for (const value of Object.values(local)) await writeUseClientModel(value === true);
}

async function sendExtension(
  client: AeonClient,
  extension: Record<string, Setting>,
): Promise<boolean> {
  const browsers = await client.settings(Object.keys(extension).length ? extension : undefined);
  if (!browsers.length) {
    process.stderr.write("No connected Chrome has Aeon loaded.\n");
    return false;
  }
  process.stdout.write(JSON.stringify(browsers.length === 1 ? browsers[0] : browsers, null, 2));
  process.stdout.write("\n");
  return true;
}

async function reportLocal(action: string, local: Record<string, Setting>): Promise<void> {
  if (action !== "set" || !Object.keys(local).length) return;
  process.stdout.write(
    `${JSON.stringify({ ...local, mcpUseClientModel: await readUseClientModel() })}\n`,
  );
}

function parsePairs(pairs: string[]): Record<string, Setting> {
  if (!pairs.length) throw new Error(settingsUsage);
  const set: Record<string, Setting> = {};
  for (const pair of pairs) {
    const [key = "", value = ""] = pair.split("=");
    if ([...FLAGS, ...LOCAL_FLAGS].includes(key) && (value === "true" || value === "false"))
      set[key] = value === "true";
    else if (key === "agentTabView" && VIEWS.includes(value)) set[key] = value;
    else throw new Error(`Unknown setting ${pair}\n${settingsUsage}`);
  }
  return set;
}
