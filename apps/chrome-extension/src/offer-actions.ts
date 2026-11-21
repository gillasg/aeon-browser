import type { AnswerOffer } from "@aeon/ui";

// Offers that act right here instead of sending a follow-up to the model: copying a site's MCP
// server, and the boost receipt's Undo / Turn off (the boost engine lives in this extension).

/** The MCP server entry that serves a mapped site's API (`aeon mcp <site>`). */
export function mcpSnippet(site: string): string {
  const name = site.replace(/[^a-z0-9.-]/gi, "-");
  return JSON.stringify(
    { mcpServers: { [name]: { command: "aeon", args: ["mcp", site] } } },
    null,
    2,
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

export type LocalOutcome = { handled: false } | { handled: true; notice: string };

async function copyMcp(offer: AnswerOffer): Promise<LocalOutcome> {
  const site = text(offer.args?.site);
  if (!site) return { handled: false };
  await navigator.clipboard.writeText(mcpSnippet(site));
  return { handled: true, notice: "Copied the MCP server for " + site };
}

function boostRequest(offer: AnswerOffer, url: string | undefined): object | undefined {
  const boostId = text(offer.args?.boostId);
  const page = text(offer.args?.url) || (url ?? "");
  if (!boostId && !page) return undefined;
  const mode = offer.action === "undo-boost" ? "undo" : "off";
  return { kind: "aeon.boost.off", url: page, mode, ...(boostId ? { boostId } : {}) };
}

async function boostOff(offer: AnswerOffer, url: string | undefined): Promise<LocalOutcome> {
  const request = boostRequest(offer, url);
  if (!request) return { handled: false };
  const reply = (await chrome.runtime.sendMessage(request).catch(() => null)) as {
    ok?: boolean;
    removed?: boolean;
    error?: string;
  } | null;
  if (!reply?.ok) throw new Error(reply?.error ?? "Couldn't turn the boost off");
  return { handled: true, notice: reply.removed ? "Boost removed" : "Boost off" };
}

/**
 * Runs an offer that needs no model. `url` is the page the run was on, so a boost without an id
 * can still be found there. Anything else is left for the follow-up text.
 */
export function localOfferAction(offer: AnswerOffer, url?: string): Promise<LocalOutcome> {
  if (offer.action === "copy-mcp") return copyMcp(offer);
  if (offer.action === "undo-boost" || offer.action === "toggle-boost") return boostOff(offer, url);
  return Promise.resolve({ handled: false });
}
