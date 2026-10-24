import { has, type Args } from "browserkit/dist/args.js";
import { out, printJson } from "browserkit/dist/output.js";
import type { Command } from "browserkit/dist/usage.js";
import type { DaemonHost } from "./host.js";

// Sites the agent may not use at all, kept in Aeon's own settings (settings → Blocked sites) and
// enforced in the browser: no tab can open one, browser.fetch and site API calls refuse it, and a
// click or redirect inside a working tab cannot reach it either. A site the user names in a
// request is allowed for that run. Only the user edits this list: no chat tool reaches it.
// This is separate from `aeon sites`, which lists mapped sites.

/** "hdfcbank.com" from whatever the user typed: a URL, a host, with or without www. */
export function siteFromInput(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") || host === "localhost" ? host : undefined;
  } catch {
    return undefined;
  }
}

function requiredSite(args: Args, usage: string): string {
  const value = args.positional[0];
  if (!value) throw new Error(usage);
  const site = siteFromInput(value);
  if (!site) throw new Error(`Not a site: ${value}`);
  return site;
}

async function block(host: DaemonHost, args: Args): Promise<number> {
  const site = requiredSite(args, "Usage: aeon block <site>");
  const result = await host.blocked("add", site);
  if (result.error) throw new Error(result.error);
  out(`Blocked ${site}. Agents will not open it, fetch it or call its API.`);
  return 0;
}

async function unblock(host: DaemonHost, args: Args): Promise<number> {
  const site = requiredSite(args, "Usage: aeon unblock <site>");
  const result = await host.blocked("remove", site);
  if (result.error) throw new Error(result.error);
  out(`Unblocked ${site}.`);
  return 0;
}

async function blocked(host: DaemonHost, args: Args): Promise<number> {
  const result = await host.blocked("read");
  if (result.error) throw new Error(result.error);
  if (has(args, "json")) printJson({ blocked: result.sites });
  else if (result.sites.length) for (const site of result.sites) out(site);
  else out("No blocked sites.");
  return 0;
}

export function blockedCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "block",
      group: "Blocked sites",
      summary: "stop every agent from using a site, for good",
      help: `Usage: aeon block <site>

Puts the site (and its subdomains) off limits for every agent: no tab opens it, browser.fetch
and site API calls refuse it, and requests a working tab makes to it (clicks, redirects,
scripts) are blocked. A site the user names in their own request is allowed for that run only.
The list is the one settings → Blocked sites shows. \`aeon sites\` lists mapped sites, which is a
different thing.`,
      run: (args) => block(host, args),
    },
    {
      name: "unblock",
      group: "Blocked sites",
      summary: "let agents use a site again",
      help: `Usage: aeon unblock <site>

Removes the site from the list \`aeon blocked\` shows.`,
      run: (args) => unblock(host, args),
    },
    {
      name: "blocked",
      group: "Blocked sites",
      summary: "list the sites agents may not use",
      help: `Usage: aeon blocked [--json]

  --json   {"blocked": [...]} instead of one site per line`,
      run: (args) => blocked(host, args),
    },
  ];
}
