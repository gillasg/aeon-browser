import { z } from "zod";

// One finished step, shared by the model line, the UI timeline and (later) the ledger.
// Labels are made only by labelFor in the engine. A value typed into a field is never here.
const stepRequest = z
  .object({
    method: z.string().max(20),
    path: z.string().max(300),
    status: z.number().int(),
  })
  .strict();

const stepDialog = z
  .object({
    type: z.string().max(40),
    message: z.string().max(300),
    accepted: z.boolean(),
  })
  .strict();

export const StepEffectSchema = z.enum(["confirmed", "unverifiable", "suspected_noop", "refused"]);
export type StepEffect = z.infer<typeof StepEffectSchema>;

export const StepEventSchema = z
  .object({
    id: z.string().min(1).max(80),
    cellId: z.string().min(1).max(80),
    chatId: z.string().min(1).max(80),
    tabId: z.number().int(),
    at: z.number(),
    ms: z.number().nonnegative(),
    kind: z.enum([
      "click",
      "fill",
      "press",
      "select",
      "upload",
      "navigate",
      "open",
      "close",
      "read",
      "api",
      "ability",
      "handoff",
      "dialog",
      "download",
    ]),
    label: z.string().max(200),
    target: z
      .object({
        role: z.string().max(80),
        name: z.string().max(160),
        id: z.number().int().optional(),
      })
      .strict()
      .optional(),
    site: z.string().max(200),
    effect: StepEffectSchema.optional(),
    evidence: z
      .object({
        request: stepRequest.optional(),
        dialog: stepDialog.optional(),
        download: z
          .object({ name: z.string().max(300) })
          .strict()
          .optional(),
        navigated: z.string().max(500).optional(),
        valueRead: z.boolean().optional(),
      })
      .strict()
      .optional(),
    write: z.boolean(),
    via: z.enum(["page", "api", "ability"]).optional(),
    box: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .strict()
      .optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();
export type StepEvent = z.infer<typeof StepEventSchema>;

const WORST: Readonly<Record<StepEffect, number>> = {
  refused: 0,
  suspected_noop: 1,
  unverifiable: 2,
  confirmed: 3,
};

/** The least successful effect in a batch. An empty list is unverifiable. */
export function worstEffect(effects: readonly string[]): StepEffect {
  let best: StepEffect = "confirmed";
  let rank = WORST.confirmed;
  for (const effect of effects) {
    if (!isEffect(effect) || WORST[effect] >= rank) continue;
    best = effect;
    rank = WORST[effect];
  }
  return effects.length ? best : "unverifiable";
}

function isEffect(value: string): value is StepEffect {
  return value in WORST;
}

/** The parenthetical on a model line: `POST /api/orders 200`, a download name, a URL. */
export function evidenceText(evidence: StepEvent["evidence"]): string {
  if (!evidence) return "";
  if (evidence.request)
    return `${evidence.request.method} ${evidence.request.path} ${evidence.request.status}`;
  if (evidence.navigated) return evidence.navigated;
  if (evidence.download?.name) return evidence.download.name;
  if (evidence.valueRead) return "value read back";
  return evidence.dialog ? evidence.dialog.message.slice(0, 80) : "";
}

/** `Click “Place order” → confirmed (POST /api/orders 200)`. */
export function actionLine(event: {
  label: string;
  effect?: string | undefined;
  evidence?: StepEvent["evidence"] | undefined;
}): string {
  const effect = event.effect || "unverifiable";
  const detail = evidenceText(event.evidence);
  return detail ? `${event.label} → ${effect} (${detail})` : `${event.label} → ${effect}`;
}
