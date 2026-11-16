// A quote in the final answer says "the page said this". The run keeps the text its tool results
// returned and the user's own words; a quote that appears in none of them was not read this run.
// It is reported as one line under the answer, never as a message and never by blocking the
// answer: the user still gets what the model wrote, and the line says what in it was not seen.

const MAX_QUOTE = 120;
const MIN_QUOTE = 4;
const MAX_LEDGER = 2_000_000;

/** Quoted spans in an answer, ignoring code: a code quote is syntax, not a claim about the page. */
export function quoteClaims(answer: string): string[] {
  const prose = answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of prose.matchAll(/"([^"\n]{4,120})"/g)) add(found, seen, match[1]);
  for (const match of prose.matchAll(/“([^”\n]{4,120})”/g)) add(found, seen, match[1]);
  for (const match of prose.matchAll(/‘([^’\n]{4,120})’/g)) add(found, seen, match[1]);
  return found;
}

function add(found: string[], seen: Set<string>, raw: string | undefined): void {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const key = text.toLowerCase();
  if (text.length < MIN_QUOTE || text.length > MAX_QUOTE || seen.has(key)) return;
  seen.add(key);
  found.push(text);
}

/** Quotes in `answer` that no text returned to the model this run contains. At most three. */
export function unreadQuotes(answer: string, readThisRun: readonly string[]): string[] {
  if (!answer.trim()) return [];
  const ledger = normalize(readThisRun.join("\n").slice(0, MAX_LEDGER));
  const unread: string[] = [];
  for (const claim of quoteClaims(answer)) {
    if (!ledger.includes(normalize(claim))) unread.push(claim);
    if (unread.length === 3) break;
  }
  return unread;
}

/** The one line under the answer. Short enough for a run-card notice (200 characters). */
export function unreadLine(claims: readonly string[]): string {
  const shown = claims
    .slice(0, 2)
    .map((claim) => `“${clip(claim, 70)}”`)
    .join(", ");
  const extra = claims.length - Math.min(2, claims.length);
  return `Not read this run: ${shown}${extra > 0 ? ` +${extra}` : ""}`;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
