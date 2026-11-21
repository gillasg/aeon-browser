import { DaemonUiRequestSchema } from "@aeon/protocol";
import { countsFor, siteKey, type SiteCounts } from "@aeon/ui";
import type { UiClient } from "./ui-client-core.js";

// Site facts for the cursor and the side panel: saved APIs and active watches come from the
// daemon's Manage snapshot, boosts that are on from this extension's boost engine.

export interface BoostRow {
  id: string;
  enabled: boolean;
  updated: number;
}

export function enabledBoostCount(rows: readonly BoostRow[]): number {
  return rows.filter((row) => row.enabled).length;
}

/** With no id from the run: the boost on this page that changed last. */
export function boostToTurnOff(rows: readonly BoostRow[]): BoostRow | undefined {
  return [...rows].filter((row) => row.enabled).sort((a, b) => b.updated - a.updated)[0];
}

export type SiteRows = readonly { site: string; apis: number; watches: number }[] | undefined;

export async function boostsOn(url: string): Promise<number> {
  const reply = (await chrome.runtime
    .sendMessage({ kind: "aeon.site.boosts", url })
    .catch(() => null)) as { boosts?: number } | null;
  return Number(reply?.boosts ?? 0) || 0;
}

export async function siteFacts(
  url: string,
  sites: () => Promise<SiteRows>,
): Promise<{ host: string; counts: SiteCounts } | undefined> {
  const host = siteKey(url);
  if (!host) return undefined;
  const [rows, boosts] = await Promise.all([sites().catch(() => undefined), boostsOn(url)]);
  return { host, counts: countsFor(host, rows, boosts) };
}

/** Saved APIs and active watches per site, from the daemon's Manage home snapshot. */
export async function homeSites(client: UiClient): Promise<SiteRows> {
  const requestId = crypto.randomUUID();
  const after = client.send(
    DaemonUiRequestSchema.parse({
      kind: "command",
      requestId,
      operation: "management.home",
      payload: {},
    }),
  );
  const response = await client.waitFor(
    (message) =>
      (message.kind === "command.completed" || message.kind === "command.failed") &&
      message.requestId === requestId,
    after,
  );
  if (response.kind !== "command.completed" || response.result.kind !== "management.home")
    return undefined;
  return response.result.snapshot.sites;
}
