// The anti-slop taste linter. Guardrails, not handcuffs: it refuses what reads as a slideshow or
// a fake, and allows lighting, motivated glides, quiet editorial lines and sound.
import { camAt, clampEase, fitScale, maxZoom, requestedZoom } from "./camera.ts";
import { holdAt } from "./hold.ts";
import { pairLayout } from "./pair.ts";
import type { DirectorEdit } from "./types.ts";

export type LintRule =
  "upscale" | "phone-floor" | "hold" | "speed-label" | "editorial" | "slide" | "effect" | "ease";
export type LintIssue = { rule: LintRule; message: string };
export type LintResult = { ok: boolean; issues: LintIssue[] };

export const PHONE_WIDTH = 390;
export const PHONE_FLOOR_PX = 9;
export const EDITORIAL_MAX_WORDS = 5;
export const BANNED_EFFECTS = ["blur", "tilt", "glow", "overshoot"];
const HYPE =
  /\b(revolutionary|game[- ]?changer|insane|mind[- ]?blowing|magic(al)?|10x|unleash|supercharge)\b/i;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** The browser viewport (output px) at clip time `t`: full frame, or its share of the Pair. */
function viewportAt(edit: DirectorEdit, t: number) {
  if (edit.pair && t >= edit.pair.pairAtMs) {
    const b = pairLayout(edit.output, 1).browser;
    return { width: b.w, height: b.h };
  }
  return { width: edit.output.width, height: edit.output.height };
}

export function lintEdit(edit: DirectorEdit): LintResult {
  const issues: LintIssue[] = [];
  const src = { width: edit.source.width, height: edit.source.height };
  const fail = (rule: LintRule, message: string) => issues.push({ rule, message });

  for (const cue of edit.cues) {
    const vp = viewportAt(edit, cue.tStart);
    const z = requestedZoom(cue, src, vp);
    const cap = maxZoom(src, vp);
    if (z > cap + 1e-6)
      fail(
        "upscale",
        `cue at ${cue.tStart} ms asks for ${z.toFixed(2)}x; ${src.width}px source allows ${cap.toFixed(2)}x into ${Math.round(vp.width)}px`,
      );
    if (cue.easeMs !== undefined && clampEase(cue.easeMs) !== cue.easeMs)
      fail("ease", `cue at ${cue.tStart} ms eases ${cue.easeMs} ms; moves take 480-620 ms`);
  }
  const anyUpscale = maxZoom(src, edit.output) < 1 - 1e-6;
  if (anyUpscale)
    fail(
      "upscale",
      `${src.width}x${src.height} source is smaller than the ${edit.output.width}x${edit.output.height} output: record at a higher DPR`,
    );

  for (const b of edit.beats) {
    if (!b.box) continue;
    const vp = viewportAt(edit, b.t);
    const cam = camAt(edit.cues, b.t, src, vp, { holds: edit.holds });
    const px = b.box.h * fitScale(src, vp) * cam.z * (PHONE_WIDTH / edit.output.width);
    if (px < PHONE_FLOOR_PX)
      fail(
        "phone-floor",
        `${b.beat} at ${b.t} ms is ${px.toFixed(1)} px tall on a ${PHONE_WIDTH} px phone (needs ${PHONE_FLOOR_PX}): push in`,
      );
  }

  for (const cue of edit.cues) {
    const ms = clampEase(cue.easeMs);
    for (const [name, t] of [
      ["starts", cue.tStart],
      ["ends", cue.tEnd],
    ] as const)
      for (const h of edit.holds)
        if (t + ms > h.tStart && t < h.tEnd)
          fail("hold", `camera ${name} moving at ${t} ms inside the hold ${h.tStart}-${h.tEnd} ms`);
  }
  edit.segments.forEach((s, i) => {
    if (i > 0 && holdAt(edit.holds, s.s0)) fail("hold", `cut at ${s.s0} ms lands inside a hold`);
    if (i < edit.segments.length - 1 && holdAt(edit.holds, s.s1))
      fail("hold", `cut at ${s.s1} ms lands inside a hold`);
    if (s.speed !== 1 && !s.label?.trim())
      fail("speed-label", `${s.s0}-${s.s1} ms plays at ${s.speed}x with no visible label`);
  });
  for (const c of edit.timeCuts)
    if (holdAt(edit.holds, c.t)) fail("hold", `time cut at ${c.t} ms lands inside a hold`);
  if (edit.pair && holdAt(edit.holds, edit.pair.pairAtMs))
    fail("hold", `pair reveal at ${edit.pair.pairAtMs} ms moves inside a hold`);

  for (const line of edit.editorial) {
    if (words(line.text) > EDITORIAL_MAX_WORDS)
      fail("editorial", `"${line.text}" is ${words(line.text)} words (max ${EDITORIAL_MAX_WORDS})`);
    if (HYPE.test(line.text))
      fail("editorial", `"${line.text}" is hype copy; let the receipt talk`);
  }
  for (const s of edit.slides)
    fail("slide", `full-screen card "${s.text}" interrupts the picture; cut it`);
  for (const e of edit.effects)
    if (BANNED_EFFECTS.includes(e.toLowerCase())) fail("effect", `effect "${e}" is not allowed`);

  return { ok: issues.length === 0, issues };
}

export function formatLint(result: LintResult): string {
  if (result.ok) return "lint: clean";
  return result.issues.map((i) => `lint ${i.rule}: ${i.message}`).join("\n");
}
