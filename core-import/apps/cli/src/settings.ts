import type { AeonClient } from "./client.js";

// `aeon settings`: read or change Aeon's agent settings in the connected Chrome. Screen recorders
// (Aperture) switch these on for a recording and restore them after; keep the names.
const FLAGS = ["agentInFront", "hideAgentCursor"];
const VIEWS = ["split", "thumbnails"];

export const settingsUsage = `  settings [get]                the agent settings in the connected Chrome
  settings set key=value ...    agentInFront=true|false hideAgentCursor=true|false
                                agentTabView=split|thumbnails`;

export async function settingsCommand(client: AeonClient, rest: string[]): Promise<number> {
  const [action = "get", ...pairs] = rest;
  if (action !== "get" && action !== "set") throw new Error(settingsUsage);
  const set = action === "set" ? parsePairs(pairs) : undefined;
  const browsers = await client.settings(set);
  if (!browsers.length) {
    process.stderr.write("No connected Chrome has Aeon loaded.\n");
    return 1;
  }
  process.stdout.write(JSON.stringify(browsers.length === 1 ? browsers[0] : browsers, null, 2));
  process.stdout.write("\n");
  return 0;
}

function parsePairs(pairs: string[]): Record<string, boolean | string> {
  if (!pairs.length) throw new Error(settingsUsage);
  const set: Record<string, boolean | string> = {};
  for (const pair of pairs) {
    const [key = "", value = ""] = pair.split("=");
    if (FLAGS.includes(key) && (value === "true" || value === "false")) set[key] = value === "true";
    else if (key === "agentTabView" && VIEWS.includes(value)) set[key] = value;
    else throw new Error(`Unknown setting ${pair}\n${settingsUsage}`);
  }
  return set;
}
