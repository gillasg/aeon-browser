// Numbers, names and dates in the answer must have been read this run. One steer, then none.

const STOP = new Set(
  "order click page tab next error shop form submit this that with from your have been will when what where which about after before there their they them then than into over also only just back here open read save send file apply done none true false null help code step cell user site data list name date time text line item show more less full part left right home menu view type kind note warn info said says ready filled".split(
    " ",
  ),
);

export interface AnswerState {
  reads: Map<string, string>;
  steered: boolean;
}

const seeds = new Map<string, string>();

export function freshAnswer(): AnswerState {
  return { reads: new Map(), steered: false };
}

/** The user prompt and the first-turn clock count as read for this chat. */
export function seedReads(chatId: string, text: string): void {
  const next = text.trim();
  if (!chatId || !next) return;
  const prior = seeds.get(chatId) ?? "";
  if (prior.includes(next)) return;
  seeds.set(chatId, prior ? `${prior}\n${next}` : next);
}

export function seededText(chatId: string): string {
  return seeds.get(chatId) ?? "";
}

export function absorbReads(state: AnswerState, text: string, stepId = ""): void {
  for (const claim of claimsIn(text)) if (!state.reads.has(claim)) state.reads.set(claim, stepId);
  for (const match of text.matchAll(/\b\d+\b/g)) {
    if (!state.reads.has(match[0])) state.reads.set(match[0], stepId);
  }
}

export function noteAnswer(state: AnswerState, text: string): { steer?: string } {
  if (state.steered) return {};
  const missing = claimsIn(text).filter((claim) => !known(state, claim));
  if (!missing.length) return {};
  state.steered = true;
  return { steer: `these were not read in this run: ${missing.join(", ")}` };
}

function known(state: AnswerState, claim: string): boolean {
  if (state.reads.has(claim)) return true;
  if (!/^\d+$/.test(claim)) return false;
  const value = Number(claim);
  const nums = [...state.reads.keys()].filter((key) => /^\d+$/.test(key)).map(Number);
  for (let left = 0; left < nums.length; left += 1) {
    for (let right = left + 1; right < nums.length; right += 1) {
      const a = nums[left] ?? 0;
      const b = nums[right] ?? 0;
      if (a + b === value || Math.abs(a - b) === value) return true;
    }
  }
  return false;
}

export function claimsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b\d{4,}\b/g)) found.add(match[0]);
  for (const match of text.matchAll(/\b\d{1,2} [A-Z][a-z]{2,8} \d{4}\b/g)) found.add(match[0]);
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) found.add(match[0]);
  for (const match of text.matchAll(/"([^"\n]{4,80})"/g)) if (match[1]) found.add(match[1]);
  for (const match of text.matchAll(/\b[A-Z][a-z]{3,}(?: [A-Z][a-z]{3,})+\b/g)) found.add(match[0]);
  for (const match of text.matchAll(/\b[A-Z][a-z]{3,}\b/g)) addName(found, text, match);
  return [...found];
}

function addName(found: Set<string>, text: string, match: RegExpMatchArray): void {
  const word = match[0];
  if (STOP.has(word.toLowerCase()) || sentenceStart(text, match.index ?? 0)) return;
  found.add(word);
}

function sentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  return before.length === 0 || /[.!?]/.test(before.at(-1) ?? "");
}
