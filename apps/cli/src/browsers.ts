import { has, type Args } from "browserkit/dist/args.js";
import { out, printJson } from "browserkit/dist/output.js";
import type { Command } from "browserkit/dist/usage.js";
import type { DaemonHost } from "./host.js";

// Each Chrome profile running Aeon is one browser. Naming one ("eval") lets
// `aeon run --browser eval` keep its chats in that profile only.

interface Browser {
  clientInstanceId: string;
  name?: string;
  tabs: number;
  sites: string[];
}

export function formatBrowser(browser: Browser): string {
  const name = browser.name ?? "(no name)";
  const sites = browser.sites.slice(0, 4).join(", ");
  return `${browser.clientInstanceId.slice(0, 8)}  ${name.padEnd(12)}  ${browser.tabs} tabs${sites ? `  ${sites}` : ""}`;
}

async function browsers(host: DaemonHost, args: Args): Promise<number> {
  const [action, target, name] = args.positional;
  if (action && action !== "name")
    throw new Error("Usage: aeon browsers [name <id|name> <new name>]");
  if (action === "name" && (!target || name === undefined))
    throw new Error('Usage: aeon browsers name <id|name> <new name>   ("" clears it)');
  const reply = await host.browsers(
    action === "name" ? { browser: String(target), name: String(name) } : undefined,
  );
  if (reply.error) throw new Error(String(reply.error));
  const list = (reply.browsers as Browser[] | undefined) ?? [];
  if (has(args, "json")) printJson({ browsers: list });
  else if (list.length) for (const browser of list) out(formatBrowser(browser));
  else out("No browser is connected. Open Chrome with Aeon loaded.");
  return 0;
}

export function browsersCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "browsers",
      group: "Aeon",
      summary: "list the connected Chrome profiles, or name one",
      help: `Usage: aeon browsers [--json]
       aeon browsers name <id|name> <new name>

Lists each connected Chrome profile running Aeon: its id, its name, and the sites open in it.
A name (for example "eval") lets \`aeon run --browser eval\` keep chats in that profile only.
<id> may be the first characters shown. An empty name ("") clears it.`,
      run: (args) => browsers(host, args),
    },
  ];
}
