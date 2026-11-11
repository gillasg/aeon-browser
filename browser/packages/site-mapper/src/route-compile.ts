// Compile a run into a route. Only a run with success evidence compiles. A correction never does.

import { createHash } from "node:crypto";
import { inferSlots } from "./route-slots.js";
import type { ObservedStep, Route, RouteStep } from "./route-types.js";

const DAY = 86_400_000;
const LIFE = 30;

export interface CompileInput {
  site: string;
  prompt: string;
  steps: ObservedStep[];
  now?: Date;
  corrected?: boolean;
}

export type CompileOutcome =
  | { ok: true; route: Route }
  | { ok: false; reason: "correction"; quirk: string; pageType: string; fingerprint: string }
  | { ok: false; reason: "no-evidence" | "empty" };

const STOP = new Set(
  "a an the to for of on in my me please show get find and or with from".split(" "),
);

export function compileRoute(input: CompileInput): CompileOutcome {
  if (!input.steps.length) return { ok: false, reason: "empty" };
  const fingerprint = fingerprintOf(input.steps);
  const pageType = input.steps.find((step) => step.pageType)?.pageType || "page";
  if (input.corrected)
    return {
      ok: false,
      reason: "correction",
      quirk: quirkText(input.prompt),
      pageType,
      fingerprint,
    };
  if (!hasSuccess(input.steps)) return { ok: false, reason: "no-evidence" };
  const inferred = inferSlots(input.prompt, input.steps);
  const steps = inferred.steps;
  const now = input.now ?? new Date();
  const signature = contentWords(input.prompt);
  const inputs = Object.fromEntries(inferred.inputs.map((item) => [item.name, item.example]));
  const route: Route = {
    id: hash(`${input.site}|${signature.join(" ")}|${fingerprint}`).slice(0, 16),
    site: input.site,
    signature,
    inputs: inferred.inputs,
    inputHistory: Object.keys(inputs).length ? [inputs] : [],
    steps,
    reads: inferred.reads,
    writes: inferred.writes,
    okRuns: 1,
    lastOkAt: now.toISOString(),
    summary: signature.slice(0, 6).join(" ") || "saved run",
    cell: draftCell(steps),
    ambiguous: inferred.ambiguous,
    expiresAt: new Date(now.getTime() + LIFE * DAY).toISOString(),
    fingerprint,
  };
  return { ok: true, route };
}

export function hasSuccess(steps: readonly ObservedStep[]): boolean {
  return steps.some((step) => {
    if (step.effect === "confirmed" || step.evidence?.valueRead || step.evidence?.download)
      return true;
    if (step.evidence?.navigated) return true;
    const status = step.evidence?.request?.status;
    return status !== undefined && status < 400;
  });
}

export function contentWords(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
  return [...new Set(words)].sort();
}

export function fingerprintOf(steps: readonly ObservedStep[]): string {
  const text = steps
    .map(
      (step) =>
        `${step.kind}|${step.target?.role ?? ""}|${step.target?.name ?? ""}|${step.write ? "w" : "r"}`,
    )
    .join("\n");
  return hash(text).slice(0, 16);
}

export function draftCell(steps: readonly RouteStep[]): string {
  return steps
    .map((step) => {
      const target = step.target ? JSON.stringify(step.target) : "";
      const args = (step.args ?? []).map((arg) => JSON.stringify(arg)).join(", ");
      const fields = [target, args].filter(Boolean).join(", ");
      return `await page.${step.kind}(${fields})`;
    })
    .join("\n");
}

export function memoryLine(ranAt: string): string {
  const date = new Date(ranAt);
  const day = date.getUTCDate();
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  return `via memory · run of ${day} ${month ?? ""}`.trim();
}

function quirkText(prompt: string): string {
  const text = `corrected: ${prompt}`.replace(/\s+/g, " ").trim();
  return text.slice(0, 120);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
