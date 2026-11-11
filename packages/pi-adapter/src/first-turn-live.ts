import type { PiBrowserContextRecord } from "@aeon/domain";
import { hostsNamed, matchAbilities, siteCapabilities } from "@browserkit/tools/site-to-api";
import { buildFirstTurn, hostOf, type FirstTurnInput } from "./first-turn.js";

/** Cursor and orb captures (the page, or text selected on it) are the tab the user is on. */
export function tabFromCapture(
  active: PiBrowserContextRecord,
): NonNullable<FirstTurnInput["activeTab"]> {
  return {
    url: active.url,
    title: active.title ?? "",
    ...(active.selectedText ? { selection: active.selectedText } : {}),
    ...(active.kind === "selection" || active.kind === "page" ? { fromCursor: true } : {}),
  };
}

const READ_CAP = 8;

export async function liveFirstTurn(
  prompt: string,
  records: PiBrowserContextRecord[],
  routeDraft?: FirstTurnInput["routeDraft"],
): Promise<string> {
  const now = process.env.AEON_SURFACE_NOW ? new Date(process.env.AEON_SURFACE_NOW) : new Date();
  const timeZone =
    process.env.AEON_SURFACE_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const active = records[0];
  const hosts = uniqueHosts([
    ...hostsNamed(prompt),
    ...records.map((record) => hostOf(record.url)),
  ]);
  const [abilities, mappedReads] = await Promise.all([
    matchAbilities(prompt, hosts, 3).catch(() => []),
    mappedReadsOf(hosts),
  ]);
  const input: FirstTurnInput = {
    prompt,
    now,
    timeZone,
    openTabs: records.slice(1).map((record) => ({
      host: hostOf(record.url),
      title: record.title ?? "",
    })),
    abilities,
    mappedReads,
    ...(active
      ? {
          activeTab: tabFromCapture(active),
        }
      : {}),
    ...(routeDraft ? { routeDraft } : {}),
  };
  return buildFirstTurn(input);
}

async function mappedReadsOf(hosts: string[]): Promise<FirstTurnInput["mappedReads"]> {
  const reads: FirstTurnInput["mappedReads"] = [];
  for (const host of hosts) {
    if (reads.length >= READ_CAP) break;
    const caps = await siteCapabilities(host).catch(() => undefined);
    for (const operation of caps?.operations ?? []) {
      if (operation.does === "write" || reads.length >= READ_CAP) continue;
      reads.push({ site: host, name: operation.name, inputs: operation.inputs });
    }
  }
  return reads;
}

function uniqueHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const host of hosts) {
    const name = host.toLowerCase().replace(/^www\./, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.slice(0, 12);
}
