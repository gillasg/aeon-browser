// A steps way keeps, per step, a role and name, a CSS path and the visible text. Replay tries the
// exact role and name, then the same role with a normalized name (case, spacing, punctuation,
// plurals), then the same role with most of the same words, and only when one control matches.
// It never acts when the match is a different control.

export interface FallbackTarget {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface PageControl {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface ControlMatch {
  control: PageControl;
  /** True when the name differs from the saved one (a fallback matched). */
  adapted: boolean;
}

/** Share of words two names must have in common for a renamed control to count. */
const OVERLAP = 0.6;

export function matchControl(
  target: FallbackTarget,
  controls: readonly PageControl[],
): PageControl | undefined {
  return resolveControl(target, controls)?.control;
}

export function resolveControl(
  target: FallbackTarget,
  controls: readonly PageControl[],
): ControlMatch | undefined {
  const exact = exactMatch(target, controls);
  if (exact) return { control: exact, adapted: false };
  if (!target.role || !target.name) return undefined;
  const sameRole = controls.filter((control) => same(control.role, target.role));
  const wanted = normalize(target.name);
  const byNormal = unique(sameRole.filter((control) => normalize(control.name) === wanted));
  if (byNormal) return { control: byNormal, adapted: true };
  const byWords = unique(
    sameRole.filter((control) => overlap(control.name, target.name) >= OVERLAP),
  );
  return byWords ? { control: byWords, adapted: true } : undefined;
}

function exactMatch(
  target: FallbackTarget,
  controls: readonly PageControl[],
): PageControl | undefined {
  if (target.role && target.name) {
    const hit = unique(
      controls.filter(
        (control) => same(control.role, target.role) && same(control.name, target.name),
      ),
    );
    if (hit) return hit;
  }
  if (target.css) {
    const hit = unique(controls.filter((control) => control.css === target.css));
    if (hit && nameAgrees(target, hit)) return hit;
  }
  if (!target.text) return undefined;
  return unique(
    controls.filter(
      (control) => same(control.text, target.text) || same(control.name, target.text),
    ),
  );
}

/** The three controls nearest the saved target, for a drift message. */
export function closestControls(
  target: FallbackTarget,
  controls: readonly PageControl[],
): PageControl[] {
  const name = target.name ?? target.text ?? "";
  return controls
    .filter((control) => control.name)
    .map((control) => ({
      control,
      score: overlap(control.name, name) + (same(control.role, target.role) ? 0.5 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.control);
}

function unique(list: PageControl[]): PageControl | undefined {
  return list.length === 1 ? list[0] : undefined;
}

function nameAgrees(target: FallbackTarget, control: PageControl): boolean {
  if (!target.name) return true;
  return same(control.name, target.name) || same(control.text, target.name);
}

function same(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function words(value: string | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(singular);
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function normalize(value: string | undefined): string {
  return words(value).join(" ");
}

/** Shared words over the longer name's word count. */
function overlap(left: string | undefined, right: string | undefined): number {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.max(a.size, b.size);
}
