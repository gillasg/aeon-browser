import { boostsCall } from "@browserkit/engine/native-browser-boosts";
import { boostToTurnOff, enabledBoostCount, type BoostRow } from "./site-facts.js";

// The service worker's half of the cursor's site facts: how many boosts are on for a page (the
// X-Ray strip), and the boost receipt's Undo / Turn off. Boosts live in this extension's own
// engine, so no model and no daemon is involved.

type FactsMessage =
  | { kind: "graft.site.boosts"; url: string }
  | { kind: "graft.boost.off"; url: string; boostId?: string; mode: "undo" | "off" };

export function installSiteFacts(): void {
  chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
    const message = request as FactsMessage | null;
    if (sender.id !== chrome.runtime.id || typeof message?.url !== "string") return;
    if (message.kind === "graft.site.boosts") {
      void listBoosts(message.url).then(
        (rows) => sendResponse({ ok: true, boosts: enabledBoostCount(rows) }),
        () => sendResponse({ ok: false, boosts: 0 }),
      );
      return true;
    }
    if (message.kind !== "graft.boost.off") return;
    void turnOff(message).then(
      (done) => sendResponse({ ok: true, ...done }),
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  });
}

async function listBoosts(url: string): Promise<BoostRow[]> {
  const rows = await boostsCall({ boosts: "list", url });
  return Array.isArray(rows) ? (rows as BoostRow[]) : [];
}

/**
 * Undo removes a boost this run created, and turns one it changed off (its earlier version is not
 * kept). Turn off disables it everywhere it applies, so a boost across several sites goes off on
 * all of them at once and stays saved.
 */
async function turnOff(
  message: Extract<FactsMessage, { kind: "graft.boost.off" }>,
): Promise<{ boostId: string; removed: boolean }> {
  const rows = message.boostId ? [] : await listBoosts(message.url);
  const boostId = message.boostId ?? boostToTurnOff(rows)?.id;
  if (!boostId) throw new Error("No boost to turn off on this page");
  const boost = (await boostsCall({ boosts: "get", id: boostId })) as {
    created?: number;
    updated?: number;
  } | null;
  if (!boost) throw new Error("That boost is already gone");
  const fresh = boost.created !== undefined && boost.created === boost.updated;
  if (message.mode === "undo" && fresh) {
    await boostsCall({ boosts: "remove", id: boostId });
    return { boostId, removed: true };
  }
  await boostsCall({ boosts: "enable", id: boostId, enabled: false });
  return { boostId, removed: false };
}
