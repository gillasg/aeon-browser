import { z } from "zod";

/**
 * How to take back a write: one uniform descriptor, whatever made the change. The UI shows the
 * label and sends the rest back to the daemon to run.
 *
 * - `ability-undo`: the site's own opposite action (remove ↔ add), run with `siteMapper.undo`.
 * - `site-script-undo`: a site script goes back to its earlier revision.
 * - `navigate-back`: the tab goes back one page.
 *
 * Nothing irreversible (paying, sending, submitting, deleting an account) ever carries one.
 */
export const RewindKindSchema = z.enum(["ability-undo", "site-script-undo", "navigate-back"]);
export type RewindKind = z.infer<typeof RewindKindSchema>;

export const RewindSchema = z
  .object({
    kind: RewindKindSchema,
    site: z.string().max(200).optional(),
    operation: z.string().max(200).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    scriptId: z.string().max(80).optional(),
    revision: z.number().int().positive().optional(),
    label: z.string().min(1).max(160),
  })
  .strict();
export type Rewind = z.infer<typeof RewindSchema>;
