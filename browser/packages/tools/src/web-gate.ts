// The user's blocked sites hold for every web client the agent has, not only the browser: crawl's
// plain HTTP (every page it follows, every redirect), mapped-site calls, and the shell proxy ask
// this gate first. The list is browserkit's site-rules.json, the same one the extension enforces.
import { useWebGate } from "browser-crawl";
import { readBlockedSites, siteName } from "./host.js";

const FRESH_MS = 5_000;
let cached: { home: string; at: number; sites: Promise<string[]> } | undefined;

function blockedSites(): Promise<string[]> {
  const home = process.env.BROWSERKIT_HOME ?? process.env.BROWSER_USE_EXTENSION_HOME ?? "";
  if (!cached || cached.home !== home || Date.now() - cached.at > FRESH_MS)
    cached = { home, at: Date.now(), sites: readBlockedSites() };
  return cached.sites;
}

/** Why a URL or site is off limits, or undefined when it may be used. */
export async function blockedSiteReason(address: string): Promise<string | undefined> {
  const host = siteName(address);
  if (!host) return undefined;
  const site = (await blockedSites()).find(
    (blocked) => host === blocked || host.endsWith("." + blocked),
  );
  return site
    ? `SITE_BLOCKED: the user blocked ${host} for the agent. Do not use it; tell the user if the task needs it.`
    : undefined;
}

export async function assertSiteAllowed(address: string | undefined): Promise<void> {
  const reason = address ? await blockedSiteReason(address) : undefined;
  if (reason) throw new Error(reason);
}

useWebGate(blockedSiteReason);
