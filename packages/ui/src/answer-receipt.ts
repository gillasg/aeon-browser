// One proof line per run, from the daemon's run card: what made this run trustworthy or fast.
// No emoji and no monospace: the first phrase is the emphasis, the rest is muted, numbers are
// tabular. When several apply, vault > repaired > speed > boost > watch. A field the daemon did
// not send is left out, never filled in.

export type ReceiptKind = "vault" | "repaired" | "speed" | "boost" | "watch";

export interface AnswerReceipt {
  kind: "receipt";
  receipt: ReceiptKind;
  /** The emphasised first phrase. */
  lead: string;
  /** The muted rest, joined with ` · `. */
  rest: string[];
  /** The whole line, for comparing and for screen readers. */
  text: string;
  /** At most 24 characters, for the minimised cursor pill. */
  short: string;
}

export const RECEIPT_PRIORITY: readonly ReceiptKind[] = [
  "vault",
  "repaired",
  "speed",
  "boost",
  "watch",
];

interface ReceiptFacts {
  receipt?: unknown;
  durationMs?: unknown;
  previousMs?: unknown;
  costUsd?: unknown;
  version?: unknown;
}

type ReceiptParts = Omit<AnswerReceipt, "kind" | "receipt" | "text">;

/** `0.8 s`, `34 s`: the same rounding as the daemon's speed line. */
export function receiptSeconds(ms: number): string {
  const seconds = ms / 1000;
  const text =
    seconds < 10 ? (Math.round(seconds * 10) / 10).toFixed(1) : String(Math.round(seconds));
  return `${text} s`;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function speedParts(facts: ReceiptFacts): ReceiptParts | null {
  const duration = finite(facts.durationMs);
  if (duration === undefined) return null;
  const cost = finite(facts.costUsd);
  const previous = finite(facts.previousMs);
  const seconds = receiptSeconds(duration);
  // "no model" unless the daemon actually computed a cost.
  const price = cost === undefined ? "no model" : "$" + cost.toFixed(2);
  return {
    lead: `${seconds} via skill`,
    rest: [price, ...(previous === undefined ? [] : [`was ${receiptSeconds(previous)}`])],
    short: `${seconds} · via skill`,
  };
}

function partsOf(kind: ReceiptKind, facts: ReceiptFacts): ReceiptParts | null {
  if (kind === "vault")
    return {
      lead: "Filled from your vault",
      rest: ["the model never saw it"],
      short: "Filled from vault",
    };
  if (kind === "repaired") {
    const version = finite(facts.version);
    return {
      lead: "Fixed itself",
      rest: version && Number.isInteger(version) ? [`now v${version}`] : [],
      short: "Fixed itself",
    };
  }
  if (kind === "speed") return speedParts(facts);
  if (kind === "boost") return { lead: "Boost on", rest: [], short: "Boost on" };
  return { lead: "Watching", rest: ["no model per check"], short: "Watching" };
}

export function formatReceipt(facts: ReceiptFacts): AnswerReceipt | null {
  const kind = RECEIPT_PRIORITY.find((item) => item === facts.receipt);
  if (!kind) return null;
  const parts = partsOf(kind, facts);
  if (!parts) return null;
  return {
    kind: "receipt",
    receipt: kind,
    ...parts,
    text: [parts.lead, ...parts.rest].join(" · "),
  };
}

export function receiptFromItem(item: object): AnswerReceipt[] {
  const receipt = formatReceipt(item as ReceiptFacts);
  return receipt ? [receipt] : [];
}

/** The one receipt a run shows. */
export function pickReceipt(lines: readonly { kind: string }[]): AnswerReceipt | undefined {
  const receipts = lines.filter((line): line is AnswerReceipt => line.kind === "receipt");
  for (const kind of RECEIPT_PRIORITY) {
    const found = receipts.filter((line) => line.receipt === kind).at(-1);
    if (found) return found;
  }
  return undefined;
}
