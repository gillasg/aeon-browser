import { pickReceipt, receiptFromItem, type AnswerReceipt } from "./answer-receipt.js";

// Lines that sit under a finished answer: one proof receipt, the speed notice, what was learned,
// and at most two offers. The daemon sends them as one run card. Nothing here is a separate card
// stream.

export type { AnswerReceipt } from "./answer-receipt.js";

export interface AnswerNotice {
  kind: "notice";
  text: string;
}

export interface AnswerLearned {
  kind: "learned";
  text: string;
}

export interface AnswerOffer {
  kind: "offer";
  id: string;
  text: string;
  label: string;
  action: string;
  followUp: string;
  /** What the daemon attached for the action (a boost id, a price, an MCP call). */
  args?: Record<string, unknown>;
}

export type AnswerLine = AnswerNotice | AnswerLearned | AnswerOffer | AnswerReceipt;

export interface AnswerWrong {
  routeId?: string;
  abilityId?: string;
}

export interface AnswerFooter {
  lines: AnswerLine[];
  wrong?: AnswerWrong;
}

export const WRONG_FOLLOW_UP = "That was wrong.";

const OFFER_CAP = 2;
const INTERNAL = /^(crawl|site_mapper|extract|tables|snipe)$/i;

const OFFER_LABEL: Record<string, string> = {
  fresh: "Do it fresh",
  "get-all": "Get all",
  "do-rest": "Do the rest",
  "learn-site": "Learn this site",
  "save-ability": "Save this as an ability",
  "save-file": "Save as file",
  watch: "Tell me when",
  schedule: "Every time",
  pin: "Pin",
  relearn: "Relearn",
  "add-to-table": "Add",
  "copy-mcp": "Copy MCP",
  "run-api": "Run via API",
  "undo-boost": "Undo",
  "toggle-boost": "Turn off",
};

const OFFER_FOLLOW_UP: Record<string, string> = {
  fresh: "Do that again from scratch, without the saved way.",
  "get-all": "Get all of the rows, not just the part you have.",
  "do-rest": "Do the rest of them.",
  "save-ability":
    "Save what you just did as an ability for this site, so next time it runs in one click without a model.",
  "save-file": "Save that as a file.",
  relearn: "That saved way broke. Learn it again.",
  pin: "",
  "copy-mcp": "",
  "run-api": "Run that again through the site's API, without the page.",
  "undo-boost": "Undo the boost you just made.",
  "toggle-boost": "Turn that boost off.",
};

/** The run-card payload, or undefined when this event is something else. */
export function runCardOf(event: object): unknown {
  const raw = event as { kind?: unknown; card?: unknown };
  return raw.kind === "run-card" ? raw.card : undefined;
}

export function footerFromCard(card: unknown): AnswerFooter | null {
  const items = itemsOf(card);
  if (!items) return null;
  const lines = mergeLines([], items.slice(0, 8).flatMap(lineFromItem));
  const wrong = wrongOf(card);
  if (!lines.length && !wrong) return null;
  return wrong ? { lines, wrong } : { lines };
}

export function mergeFooters(current: AnswerFooter | undefined, next: AnswerFooter): AnswerFooter {
  const lines = mergeLines(current?.lines ?? [], next.lines);
  const wrong = next.wrong ?? current?.wrong;
  return wrong ? { lines, wrong } : { lines };
}

export function attachFooter<T extends { footer?: AnswerFooter | undefined }>(
  run: T,
  card: unknown,
): T {
  const next = footerFromCard(card);
  if (!next) return run;
  return { ...run, footer: mergeFooters(run.footer, next) };
}

function itemsOf(card: unknown): unknown[] | undefined {
  if (!card || typeof card !== "object") return undefined;
  const items = (card as { items?: unknown }).items;
  return Array.isArray(items) ? items : undefined;
}

function wrongOf(card: unknown): AnswerWrong | undefined {
  const wrong = (card as { wrong?: unknown }).wrong;
  if (!wrong || typeof wrong !== "object") return undefined;
  const routeId = clip((wrong as { routeId?: unknown }).routeId, 80);
  const abilityId = clip((wrong as { abilityId?: unknown }).abilityId, 200);
  if (!routeId && !abilityId) return undefined;
  return {
    ...(routeId ? { routeId } : {}),
    ...(abilityId ? { abilityId } : {}),
  };
}

function lineFromItem(item: unknown): AnswerLine[] {
  if (!item || typeof item !== "object") return [];
  const kind = (item as { kind?: unknown }).kind;
  if (kind === "notice") return noticeLine(item);
  if (kind === "learned") return learnedLine(item);
  if (kind === "offer") return offerLine(item);
  if (kind === "receipt") return receiptFromItem(item);
  return [];
}

function noticeLine(item: object): AnswerNotice[] {
  const text = clip((item as { text?: unknown }).text, 200);
  if (!text || INTERNAL.test(text)) return [];
  return [{ kind: "notice", text }];
}

function learnedLine(item: object): AnswerLearned[] {
  const name = clip((item as { name?: unknown }).name, 80);
  if (!name || INTERNAL.test(name)) return [];
  return [{ kind: "learned", text: `Learned: ${name}` }];
}

function offerLine(item: object): AnswerOffer[] {
  const id = clip((item as { id?: unknown }).id, 200);
  const text = clip((item as { text?: unknown }).text, 200);
  const action = clip((item as { action?: unknown }).action, 40);
  const args = argsOf((item as { args?: unknown }).args);
  if (!id || !text || !action || INTERNAL.test(text)) return [];
  const label = offerLabel(action, text, args);
  if (!label) return [];
  return [
    {
      kind: "offer",
      id,
      text,
      action,
      label,
      followUp: offerFollowUp(action, text, args),
      ...(args ? { args } : {}),
    },
  ];
}

function argsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The run's own price, as the daemon sent it, or nothing (no number, no offer). */
function watchPrice(args: Record<string, unknown> | undefined): string {
  const price = Number(args?.price);
  if (!Number.isFinite(price) || price <= 0) return "";
  const currency = typeof args?.currency === "string" ? args.currency.slice(0, 3) : "";
  return currency + (Number.isInteger(price) ? String(price) : price.toFixed(2));
}

/** `Watch under ₹49999`, at most 18 characters, or no label. */
export function watchBelowLabel(args: Record<string, unknown> | undefined): string {
  const price = watchPrice(args);
  const label = price ? `Watch under ${price}` : "";
  return label.length <= 18 ? label : "";
}

function offerLabel(action: string, text: string, args: Record<string, unknown> | undefined) {
  if (action === "watch-below") return watchBelowLabel(args);
  return OFFER_LABEL[action] ?? text.slice(0, 40);
}

function offerFollowUp(action: string, text: string, args: Record<string, unknown> | undefined) {
  if (action === "watch-below")
    return `Tell me when the price on this page drops below ${watchPrice(args)}.`;
  return action in OFFER_FOLLOW_UP ? (OFFER_FOLLOW_UP[action] ?? "") : text;
}

function mergeLines(current: readonly AnswerLine[], next: readonly AnswerLine[]): AnswerLine[] {
  const notices = uniqueNotices([...current, ...next]);
  const learned = [...current, ...next].filter(isLearned).at(-1);
  const offers = uniqueOffers([...current, ...next]).slice(0, OFFER_CAP);
  const receipt = pickReceipt([...current, ...next]);
  return [...(receipt ? [receipt] : []), ...notices, ...(learned ? [learned] : []), ...offers];
}

function uniqueNotices(lines: readonly AnswerLine[]): AnswerNotice[] {
  const seen = new Set<string>();
  const notices: AnswerNotice[] = [];
  for (const line of lines) {
    if (line.kind !== "notice" || seen.has(line.text)) continue;
    seen.add(line.text);
    notices.push(line);
  }
  return notices;
}

function uniqueOffers(lines: readonly AnswerLine[]): AnswerOffer[] {
  const seen = new Set<string>();
  const offers: AnswerOffer[] = [];
  for (const line of lines) {
    if (line.kind !== "offer" || seen.has(line.id)) continue;
    seen.add(line.id);
    offers.push(line);
  }
  return offers;
}

function isLearned(line: AnswerLine): line is AnswerLearned {
  return line.kind === "learned";
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
