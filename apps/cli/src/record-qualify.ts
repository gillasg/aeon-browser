// `graft record qualify <clip.json> --runs 3`: the grammar's precondition for filming. The clip's
// scenes run N times in a row as raw tab takes (each scene's `prepare` resets the site first),
// every run is checked against the clip's `expect`, and qualify.json records the plan hash, the
// day and each run. `graft film` refuses a plan without a same-day N/N on the same hash.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { DaemonHost } from "./host.js";
import type { RecordingEvents } from "./record-events.js";
import type { RecordSteps } from "./record-script.js";
import { parsePlan, type ShootPlan } from "./record-shoot.js";
import { readRecording } from "./record-terminal.js";

export type Expect = {
  /** The receipt beat's text contains this. */
  receipt?: string;
  /** Upper bound on the receipt's own seconds (`0.4 s · …`). */
  maxSeconds?: number;
  /** The terminal cast contains this line text. */
  terminal?: string;
  /** Every take is a clean frame. Default true. */
  clean?: boolean;
};
export type ClipFile = {
  plan: ShootPlan;
  expect: Expect;
  end?: { command: string; repo?: string };
  targetMs?: number;
  maxMinutes?: number;
};
export type QualifyRun = { ok: boolean; reasons: string[]; ms: number };
export type QualifyFile = { planHash: string; date: string; runs: QualifyRun[] };

export const QUALIFY_RUNS = 3;

/** clip.json: {scenes, expect?, end?, targetMs?, maxMinutes?} — a shoot plan plus its checks. */
export function parseClip(raw: unknown): ClipFile {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const expect = (typeof obj.expect === "object" && obj.expect ? obj.expect : {}) as Expect;
  const end = obj.end as ClipFile["end"];
  return {
    plan: parsePlan(raw),
    expect,
    ...(end && typeof end.command === "string" ? { end } : {}),
    ...(typeof obj.targetMs === "number" ? { targetMs: obj.targetMs } : {}),
    ...(typeof obj.maxMinutes === "number" ? { maxMinutes: obj.maxMinutes } : {}),
  };
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

/** Stable hash of what is filmed and checked: scenes + expect (not output paths). */
export function planHash(clip: ClipFile): string {
  const body = JSON.stringify(canonical({ scenes: clip.plan.scenes, expect: clip.expect }));
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export const today = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

const seconds = (text: string | undefined) => {
  const m = /(\d+(?:\.\d+)?)\s*s\b/.exec(text ?? "");
  return m ? Number(m[1]) : undefined;
};

/** Why one run's takes fail the clip's expect (empty when they pass). */
export function checkRun(takes: (RecordingEvents | undefined)[], expect: Expect): string[] {
  const reasons: string[] = [];
  const all = takes.filter((t): t is RecordingEvents => !!t);
  if (all.length < takes.length) reasons.push("a take wrote no events.json");
  const receipts = all.flatMap((t) => t.events.filter((e) => e.beat === "receipt"));
  const want = expect.receipt;
  if (want && !receipts.some((r) => r.text?.includes(want)))
    reasons.push(`no receipt contains "${expect.receipt}"`);
  if (expect.maxSeconds !== undefined) {
    const s = receipts.map((r) => seconds(r.text)).find((v) => v !== undefined);
    if (s === undefined || s > expect.maxSeconds)
      reasons.push(`receipt took ${s ?? "?"} s (max ${expect.maxSeconds} s)`);
  }
  if (expect.terminal) {
    const text = all.flatMap((t) => t.terminal?.events.map((e) => e.text) ?? []).join("\n");
    if (!text.includes(expect.terminal))
      reasons.push(`terminal never printed "${expect.terminal}"`);
  }
  if (expect.clean !== false && all.some((t) => t.clip.clean === false))
    reasons.push("a take was not a clean frame");
  return reasons;
}

/** True when `file` is a same-day, all-pass series of at least `runs` on this plan. */
export function qualified(
  file: QualifyFile | undefined,
  hash: string,
  now = Date.now(),
  runs = QUALIFY_RUNS,
): { ok: boolean; why?: string } {
  if (!file) return { ok: false, why: "no qualify.json: run `graft record qualify <clip.json>`" };
  if (file.planHash !== hash) return { ok: false, why: "the plan changed since it qualified" };
  if (file.date !== today(now)) return { ok: false, why: `qualified on ${file.date}, not today` };
  const passed = file.runs.filter((r) => r.ok).length;
  if (file.runs.length < runs || passed < file.runs.length)
    return { ok: false, why: `${passed}/${file.runs.length} runs passed (needs ${runs}/${runs})` };
  return { ok: true };
}

export const qualifyPath = (clipPath: string): string =>
  join(dirname(resolve(clipPath)), "qualify.json");

export function readQualify(clipPath: string): QualifyFile | undefined {
  const path = qualifyPath(clipPath);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as QualifyFile;
  } catch {
    return undefined;
  }
}

/** What qualifying needs from the world: one raw shoot of the plan into a folder. */
export type QualifyDeps = {
  shoot(plan: ShootPlan, dir: string): Promise<string[]>;
  read(folder: string): RecordingEvents | undefined;
  now(): number;
  log(line: string): void;
};

export async function qualify(
  clip: ClipFile,
  dir: string,
  runs: number,
  deps: QualifyDeps,
): Promise<QualifyFile> {
  const results: QualifyRun[] = [];
  for (let i = 0; i < runs; i++) {
    const started = deps.now();
    let reasons: string[];
    try {
      const folders = await deps.shoot(clip.plan, join(dir, `run-${i + 1}`));
      reasons = checkRun(folders.map(deps.read), clip.expect);
    } catch (error) {
      reasons = [(error as Error).message];
    }
    const run = { ok: reasons.length === 0, reasons, ms: deps.now() - started };
    deps.log(`qualify run ${i + 1}/${runs}: ${run.ok ? "pass" : reasons.join("; ")}`);
    results.push(run);
    if (!run.ok) break; // three in a row: one failure ends the series
  }
  return { planHash: planHash(clip), date: today(deps.now()), runs: results };
}

export async function qualifyCommand(
  host: DaemonHost,
  steps: RecordSteps,
  args: Args,
): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: graft record qualify <clip.json> [--runs 3]");
  const clip = parseClip(JSON.parse(readFileSync(file, "utf8")));
  const runs = Number(typeof args.flags.runs === "string" ? args.flags.runs : QUALIFY_RUNS);
  const dir = join(dirname(resolve(file)), `qualify-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const { liveShootDeps } = await import("./record-shoot-cmd.js");
  const { shoot } = await import("./record-shoot.js");
  const takeArgs: Args = { positional: [], flags: { tabs: true } };
  const result = await qualify(clip, dir, runs, {
    shoot: (plan, out) => shoot(plan, out, liveShootDeps(host, steps, takeArgs)),
    read: readRecording,
    now: Date.now,
    log: steps.log,
  });
  writeFileSync(qualifyPath(file), JSON.stringify(result, null, 2) + "\n");
  const verdict = qualified(result, result.planHash, Date.now(), runs);
  steps.log(
    verdict.ok
      ? `Qualified ${runs}/${runs}: ${qualifyPath(file)}`
      : `Not qualified: ${verdict.why}`,
  );
  return verdict.ok ? 0 : 1;
}
