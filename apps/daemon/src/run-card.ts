// A run card is facts from the run, written by the daemon. At most one learned item and two
// offers. Declined offers stay declined. An ours error, a tip, or a check that found nothing
// is never a card.

import type { RunCard, RunCardItem } from "@aeon/protocol";

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
  learned?: { abilityId: string; name: string; site: string };
  routeId?: string;
  abilityId?: string;
  ours?: boolean;
  declined?: string[];
}

type Offer = Extract<RunCardItem, { kind: "offer" }>;
type Notice = Extract<RunCardItem, { kind: "notice" }>;

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
  const notices = noticesFor(facts);
  const learned = facts.learned ? [learnedItem(facts.learned)] : [];
  const offers = offersFor(facts).filter((offer) => !declined.has(offer.id));
  const kept = offers.slice(0, 2);
  const extra = offers.length - kept.length;
  if (extra > 0) notices.push({ kind: "notice", text: `+${extra}` });
  const items = [...notices, ...learned, ...kept];
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

function noticesFor(facts: RunFacts): Notice[] {
  if (facts.durationMs === undefined || !facts.path) return [];
  return [{ kind: "notice", text: speedText(facts.durationMs, facts.path, facts.previousMs) }];
}

function offersFor(facts: RunFacts): Offer[] {
  const id = (action: string) => `${action}:${facts.site}:${facts.task}`;
  const offers: Offer[] = [];
  if (facts.fromMemory)
    offers.push({ kind: "offer", id: id("fresh"), text: "Do it fresh", action: "fresh" });
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
