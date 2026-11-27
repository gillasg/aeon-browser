// The optional second look before sharing: a model reads the public definition and the ability
// and says whether the claims match what the ways do. It is a separate command; the deterministic
// lint runs first and no local save or run ever calls a model.

import type { Ability } from "./abilities.js";
import { publicAbility } from "./ability-publish.js";
import { createRedactor } from "./redact.js";

/** The model Graft already uses for one-off work (the companion request path). */
export const REVIEW_MODEL = "opencode-go/deepseek-v4.1-flash";

export interface ReviewFinding {
  path?: string;
  note: string;
}

export interface AbilityReview {
  verdict: "allow" | "deny";
  findings: ReviewFinding[];
}

export function reviewSystem(): string {
  return [
    "You review one saved browser ability before it is shared with someone else.",
    "The JSON has a public definition (what callers see) and the private ability (ways, tests, options).",
    "Answer with JSON only, no prose and no code fence:",
    '{"verdict":"allow"|"deny","findings":[{"path":"inputs.q","note":"..."}]}',
    "Deny when: the description or name claims more than the ways do; an output field is not supported by any way; a declared input is really the recorded example; a write cannot be read back; or the ability would only work in the recorder's own account.",
    "Allow when the claims are honest, even if the ability is small or narrow.",
    "Never ask for a login, a confirmation step or a permission prompt.",
  ].join("\n");
}

/** The review request: the public definition plus the ability with secrets redacted. */
export function reviewPrompt(ability: Ability): string {
  const redacted = createRedactor().json(ability);
  return JSON.stringify({ public: publicAbility(ability), ability: redacted }, null, 2);
}

/** Reads the model's JSON. A reply that is not the agreed shape is an error, never a silent allow. */
export function parseReview(text: string): AbilityReview {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("ABILITY_REVIEW_UNPARSABLE: no JSON in the reply");
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("ABILITY_REVIEW_UNPARSABLE: the reply is not JSON");
  }
  const review = value as { verdict?: unknown; findings?: unknown };
  if (review.verdict !== "allow" && review.verdict !== "deny")
    throw new Error("ABILITY_REVIEW_UNPARSABLE: verdict must be allow or deny");
  return {
    verdict: review.verdict,
    findings: Array.isArray(review.findings) ? review.findings.map(toFinding).filter(hasNote) : [],
  };
}

function toFinding(item: unknown): ReviewFinding {
  if (typeof item === "string") return { note: item.slice(0, 600) };
  const value = item as { path?: unknown; note?: unknown };
  return {
    ...(typeof value?.path === "string" ? { path: value.path.slice(0, 300) } : {}),
    note: String(value?.note ?? "").slice(0, 600),
  };
}

function hasNote(finding: ReviewFinding): boolean {
  return finding.note.length > 0;
}
