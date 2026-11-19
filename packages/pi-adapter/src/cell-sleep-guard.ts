// A cell that plainly sleeps longer than its deadline can never finish: the model writes
// `for (let i = 0; i < 60; i++) await sleep(2000)` against a 60 s cell and every step times out.
// Reject that class up front with a short reason that says the deadline and how to split the work.
// The check is deliberately conservative: only literal waits and literal loop counts count, so a
// cell that waits on real conditions is never blocked.

const SLEEP_FORMS: RegExp[] = [
  /\bsetTimeout\s*\([^,)]*,\s*(\d+(?:\.\d+)?)\s*\)/g,
  /\bwaitForTimeout\s*\(\s*(\d+(?:\.\d+)?)/g,
  /\b(?:__sleep|sleep)\s*\(\s*(\d+(?:\.\d+)?)/g,
  /\.wait\(\s*(\d+(?:\.\d+)?)\s*\)/g,
];
const FOR_HEADER =
  /\bfor\s*\(\s*(?:let|var|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*\d+\s*;\s*\1\s*<\s*(\d+)\s*;[^{;]*?\)\s*/g;

/** Comments and string contents are not code that waits. */
function withoutLiterals(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, '""');
}

function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}" && --depth === 0) return index;
  }
  return code.length;
}

interface Loop {
  start: number;
  end: number;
  count: number;
}

/** The body of each counted loop, brace or single statement, outermost loops only. */
function loops(code: string): Loop[] {
  const found: Loop[] = [];
  for (const match of code.matchAll(FOR_HEADER)) {
    const after = (match.index ?? 0) + match[0].length;
    if (code[after] === "{")
      found.push({
        start: after + 1,
        end: matchingBrace(code, after),
        count: Math.min(Number(match[2]) || 0, 100_000),
      });
    else {
      const end = code.indexOf(";", after);
      found.push({
        start: after,
        end: end === -1 ? code.length : end,
        count: Math.min(Number(match[2]) || 0, 100_000),
      });
    }
  }
  return found.filter(
    (range, index) =>
      !found.some(
        (other, otherIndex) =>
          index !== otherIndex && other.start <= range.start && other.end >= range.end,
      ),
  );
}

function waits(code: string): number {
  let total = 0;
  for (const form of SLEEP_FORMS)
    for (const match of code.matchAll(form)) total += Number(match[1]) || 0;
  return total;
}

function estimate(code: string, factor: number): number {
  const ranges = loops(code);
  let total = 0;
  let cursor = 0;
  for (const range of ranges) {
    total += factor * waits(code.slice(cursor, range.start));
    total += estimate(code.slice(range.start, range.end), factor * range.count);
    cursor = range.end;
  }
  return total + factor * waits(code.slice(cursor));
}

/** Milliseconds of plainly declared, fixed waits in a cell (loops with literal counts included). */
export function cellSleepMs(code: string): number {
  return estimate(withoutLiterals(code), 1);
}

// Fixed waits that fill most of the deadline leave no time for the page work between them: a
// 10 x 6 s polling loop against a 60 s cell always times out once its reads are added.
const HEADROOM = 0.85;

/** True when a cell's fixed waits alone use up its deadline (with room left for real work). */
export function sleepsPastDeadline(sleepMs: number, timeoutMs: number): boolean {
  return sleepMs > 0 && sleepMs >= timeoutMs * HEADROOM;
}

export function cellSleepRefusal(timeoutMs: number, sleepMs: number): string {
  const seconds = (ms: number) => Math.round(ms / 1000);
  return `BLOCKED: this cell's fixed waits add up to ~${seconds(sleepMs)} s, leaving no room in its ${seconds(timeoutMs)} s deadline. Split the work into shorter cells (the REPL keeps variables), wait for a real condition with page.waitFor, or use browser.job for a long sweep.`;
}
