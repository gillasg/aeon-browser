import { z } from "zod";

// Requests from other extensions (such as Site Boosts) that the browser extension passes to core:
// a model completion with the user's sign-in, or a task for the agent (watch a price).

const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);

export const CompanionRequestSchema = z
  .object({
    kind: z.literal("companion.request"),
    requestId: z.string().uuid(),
    from: ExtensionIdSchema,
    request: z.enum(["model.complete", "watch", "task"]),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CompanionRequest = z.infer<typeof CompanionRequestSchema>;

export const CompanionResultSchema = z
  .object({
    kind: z.literal("companion.result"),
    requestId: z.string().uuid(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().max(4000).optional(),
  })
  .strict();
export type CompanionResult = z.infer<typeof CompanionResultSchema>;
