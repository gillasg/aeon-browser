// A run card is facts from the run, written by the daemon. At most one learned item and two
// offers. Declined offers stay declined. An ours error, a tip, or a check that found nothing
// is never a card.

import type { RunCard, RunCardItem } from "@aeon/protocol";
import { missingFileLine } from "./missing-answer-files.js";
import { unreadLine } from "./unread-quotes.js";

export type SpeedPath = "from memory" | "with a saved draft" | "saved ability" | "first time";

export interface RunFacts {
  chatId: string;
  runId: string;
  site: string;
  task: string;
  durationMs?: number;
  previousMs?: number;
  path?: SpeedPath;
  partial?: { have: number; total: number };
  longFirstRun?: boolean;
  fromMemory?: boolean;
  /** The run worked after a retry, a failure or a correction, and no ability covers it yet. */
  saveAbility?: boolean;
  learned?: { abilityId: string; name: string; site: string };
  routeId?: string;
  abilityId?: string;
  ours?: boolean;
  declined?: string[];
  /** Quotes in the answer that no text returned to the model this run contains. */
  unread?: string[];
  /** Local files the answer links that are not in the workspace or its downloads/. */
  missingFiles?: string[];
  /** Proof facts. Each is set only when the daemon saw it happen; see receiptFor. */
  proof?: RunProof;
}

/** What a receipt may claim. A field the daemon did not see stays unset, and nothing is shown. */
export interface RunProof {
  /** The engine filled a field from the credential store and the value never reached the model. */
  vault?: boolean;
  /** Drift repair bumped the ability to this version during the run. */
  repairedVersion?: number;
  /** The run made no model call at all (a saved site API answered). */
  modelFree?: boolean;
  /** Only when the cost was computed. */
  costUsd?: number;
  boost?: { boostId?: string; edit: boolean; url?: string };
  /** A watch whose check runs with no model was created. */
  deterministicWatch?: boolean;
  /** The run read the site through its mapped API, so the site can be served over MCP. */
  usedApi?: boolean;
  /** The site has saved ways the run did not use; it went through the page instead. */
  apiAvailable?: boolean;
}

type Offer = Extract<RunCardItem, { kind: "offer" }>;
type Notice = Extract<RunCardItem, { kind: "notice" }>;
type Receipt = Extract<RunCardItem, { kind: "receipt" }>;

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  const text =
    seconds < 10 ? (Math.round(seconds * 10) / 10).toFixed(1) : String(Math.round(seconds));
  return `${text} s`;
}

/** `0.4 s · saved ability`, `38 s · first time`, `1.1 s · from memory (was 38 s)`. */
export function speedText(ms: number, path: SpeedPath, previousMs?: number): string {
  const base = `${formatDuration(ms)} · ${path}`;
  return previousMs === undefined ? base : `${base} (was ${formatDuration(previousMs)})`;
}

export function buildRunCard(facts: RunFacts): RunCard | undefined {
  if (facts.ours) return undefined;
  const declined = new Set(facts.declined ?? []);
  const receipt = receiptFor(facts);
  const notices = noticesFor(facts, receipt);
  const learned = facts.learned ? [learnedItem(facts.learned)] : [];
  const offers = [...receiptOffers(facts, receipt), ...offersFor(facts)].filter(
    (offer) => !declined.has(offer.id),
  );
  const kept = offers.slice(0, 2);
  const extra = offers.length - kept.length;
  if (extra > 0) notices.push({ kind: "notice", text: `+${extra}` });
  const items = [...(receipt ? [receipt] : []), ...notices, ...learned, ...kept];
  if (!items.length) return undefined;
  return {
    chatId: facts.chatId,
    runId: facts.runId,
    items,
    wrong: {
      ...(facts.routeId ? { routeId: facts.routeId } : {}),
      ...(facts.abilityId ? { abilityId: facts.abilityId } : {}),
    },
  };
}

function learnedItem(learned: NonNullable<RunFacts["learned"]>): RunCardItem {
  return { kind: "learned", abilityId: learned.abilityId, name: learned.name, site: learned.site };
}

/** The one receipt, by priority: vault > repaired > speed > boost > watch. */
export function receiptFor(facts: RunFacts): Receipt | undefined {
  const proof = facts.proof;
  if (!proof) return undefined;
  if (proof.vault) return { kind: "receipt", receipt: "vault" };
  if (proof.repairedVersion) {
    return { kind: "receipt", receipt: "repaired", version: proof.repairedVersion };
  }
  if (proof.modelFree && facts.durationMs !== undefined)
    return {
      kind: "receipt",
      receipt: "speed",
      durationMs: facts.durationMs,
      ...(facts.previousMs !== undefined ? { previousMs: facts.previousMs } : {}),
      ...(proof.costUsd !== undefined ? { costUsd: proof.costUsd } : {}),
    };
  if (proof.boost) return { kind: "receipt", receipt: "boost" };
  if (proof.deterministicWatch) return { kind: "receipt", receipt: "watch" };
  return undefined;
}

function boostOffer(facts: RunFacts, boost: NonNullable<RunProof["boost"]>): Offer {
  const action = boost.edit ? "toggle-boost" : "undo-boost";
  const args = {
    ...(boost.boostId ? { boostId: boost.boostId } : {}),
    ...(boost.url ? { url: boost.url } : {}),
  };
  return {
    kind: "offer",
    id: `${action}:${facts.site}:${facts.task}`,
    text: "Boost on",
    action,
    args,
  };
}

/** The receipt's own button comes first; it counts toward the two offers. */
function receiptOffers(facts: RunFacts, receipt: Receipt | undefined): Offer[] {
  const id = (action: string) => `${action}:${facts.site}:${facts.task}`;
  const proof = facts.proof ?? {};
  if (receipt?.receipt === "boost" && proof.boost) return [boostOffer(facts, proof.boost)];
  if (receipt?.receipt === "speed" || proof.usedApi) {
    const args = { site: facts.site };
    return [{ kind: "offer", id: id("copy-mcp"), text: "Copy MCP", action: "copy-mcp", args }];
  }
  if (proof.apiAvailable)
    return [{ kind: "offer", id: id("run-api"), text: "Run via API", action: "run-api" }];
  return [];
}

function noticesFor(facts: RunFacts, receipt: Receipt | undefined): Notice[] {
  const notices: Notice[] = [];
  if (facts.unread?.length)
    notices.push({ kind: "notice", text: unreadLine(facts.unread).slice(0, 200) });
  if (facts.missingFiles?.length)
    notices.push({ kind: "notice", text: missingFileLine(facts.missingFiles).slice(0, 200) });
  // The speed receipt already says how long it took.
  if (facts.durationMs !== undefined && facts.path && receipt?.receipt !== "speed")
    notices.push({
      kind: "notice",
      text: speedText(facts.durationMs, facts.path, facts.previousMs),
    });
  return notices;
}

function offersFor(facts: RunFacts): Offer[] {
  const id = (action: string) => `${action}:${facts.site}:${facts.task}`;
  const offers: Offer[] = [];
  if (facts.fromMemory)
    offers.push({ kind: "offer", id: id("fresh"), text: "Do it fresh", action: "fresh" });
  if (facts.saveAbility)
    offers.push({
      kind: "offer",
      id: id("save-ability"),
      text: "Save this as an ability, so next time is one call.",
      action: "save-ability",
    });
  if (facts.partial && facts.partial.have < facts.partial.total)
    offers.push({
      kind: "offer",
      id: id("get-all"),
      text: `Partial: ${facts.partial.have} of ${facts.partial.total} rows.`,
      action: "get-all",
    });
  if (facts.longFirstRun && !facts.fromMemory)
    offers.push({
      kind: "offer",
      id: id("learn-site"),
      text: `Learn ${facts.site} in the background so this takes seconds.`,
      action: "learn-site",
    });
  return offers;
}
