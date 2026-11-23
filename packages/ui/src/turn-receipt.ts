import type { AnswerFooter, AnswerLine } from "./answer-lines.js";

// A finished turn shows one quiet duration under its answer: `33s`, or `⚡ 0.4s` on a fast path.
// It is the only duration the turn shows, so the daemon's own speed receipt and timing
// notices fold into it rather than sitting under it with a second, contradicting number.

/** `4s`, `1m 12s`: the turn's elapsed time. */
export function formatSeconds(seconds: number): string {
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}

/**
 * What made a run fast, in the receipt's words: `via skill`, `from memory`, `via site skill`.
 * Only a known execution phrase at the end of a speed notice (`1.1 s · from memory (was 38 s)`)
 * counts. Any other notice (`Not read this run: "**…**"`, warnings, errors) is never a `via`.
 */
const VIA_PHRASES = new Map<string, string>([
  ["via skill", "via skill"],
  ["via skills", "via skill"],
  ["via ability", "via skill"],
  ["via abilities", "via skill"],
  ["via site skill", "via site skill"],
  ["via site skills", "via site skill"],
  ["via site api", "via site API"],
  ["via api", "via API"],
  ["from memory", "from memory"],
  ["from cache", "from cache"],
  ["skill", "via skill"],
  ["site skill", "via site skill"],
]);

export function receiptVia(footer: AnswerFooter | undefined): string {
  for (const line of footer?.lines ?? []) {
    if (line.kind === "receipt" && line.receipt === "speed") return "via skill";
    if (line.kind !== "notice") continue;
    // `1.1 s · from memory (was 38 s)`: keep the words, never the second duration.
    const tail = (line.text.split(" · ").at(-1) ?? "").replace(/\s*\(.*\)\s*$/, "").trim();
    const known = VIA_PHRASES.get(tail.toLowerCase());
    if (known) return known;
  }
  return "";
}

/** `33s`, or `⚡ 0.4s` when a fast path (a skill, a Site API, a replay) answered. */
export function receiptText(seconds: number, via: string): string {
  return via ? `⚡ ${formatSeconds(seconds)}` : formatSeconds(seconds);
}

/** The footer without the lines the receipt already says (its time and what made it fast). */
export function linesAfterReceipt(footer: AnswerFooter): AnswerFooter {
  const kept = footer.lines.filter(
    (line: AnswerLine) =>
      line.kind !== "notice" && !(line.kind === "receipt" && line.receipt === "speed"),
  );
  return { ...footer, lines: kept };
}
