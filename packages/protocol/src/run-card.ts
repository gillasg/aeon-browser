import { z } from "zod";

export const RunCardOfferActionSchema = z.enum([
  "learn-site",
  "schedule",
  "watch",
  "save-file",
  "get-all",
  "do-rest",
  "fresh",
  "relearn",
  "pin",
  "add-to-table",
]);

export const RunCardItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("notice"),
      text: z.string().max(200),
      detail: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("learned"),
      abilityId: z.string().min(1).max(200),
      name: z.string().min(1).max(80),
      site: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("offer"),
      id: z.string().min(1).max(200),
      text: z.string().max(200),
      action: RunCardOfferActionSchema,
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);

export const RunCardSchema = z
  .object({
    chatId: z.string().min(1).max(80),
    runId: z.string().min(1).max(80),
    items: z.array(RunCardItemSchema).max(8),
    wrong: z
      .object({
        routeId: z.string().max(80).optional(),
        abilityId: z.string().max(200).optional(),
      })
      .strict(),
  })
  .strict();

export type RunCardItem = z.infer<typeof RunCardItemSchema>;
export type RunCard = z.infer<typeof RunCardSchema>;
