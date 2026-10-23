import { z } from "zod";
import { ChatIdSchema, ChatSummarySchema, EffectivePiResourcesSchema } from "./chat-catalog-dto.js";

export const HomeRoutineCardSchema = z
  .object({
    routineId: z.string().uuid(),
    chatId: ChatIdSchema,
    chatTitle: z.string().min(1).max(120),
    title: z.string().min(1).max(120),
    nextDueAt: z.string().datetime().nullable(),
    enabled: z.boolean(),
  })
  .strict();

export const HomeManagementSnapshotSchema = z
  .object({ routines: z.array(HomeRoutineCardSchema).max(3) })
  .strict();

export type HomeRoutineCardDto = z.infer<typeof HomeRoutineCardSchema>;
export type HomeManagementSnapshotDto = z.infer<typeof HomeManagementSnapshotSchema>;

const RoutineScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("interval"),
      everyMinutes: z.number().int().positive(),
      anchorUtc: z.string().datetime(),
      timeZone: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("calendar"),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      localTime: z.string().regex(/^\d{2}:\d{2}$/),
      timeZone: z.string().min(1).max(100),
    })
    .strict(),
]);

const ManagementRoutineSchema = z
  .object({
    routineId: z.string().uuid(),
    chatId: ChatIdSchema,
    chatTitle: z.string().min(1).max(120),
    title: z.string().min(1).max(120),
    instruction: z.string().min(1).max(20_000),
    schedule: RoutineScheduleSchema,
    /** It runs a check with no model first (a learned API, a page read); the agent only when it passes. */
    checks: z.boolean().optional(),
    nextDueAt: z.string().datetime().nullable(),
    requiredBrowserInstanceId: z.string().uuid().nullable(),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    recentRuns: z
      .array(
        z
          .object({
            runId: z.string().uuid(),
            scheduledSlot: z.string().max(100),
            manual: z.boolean(),
            state: z.enum([
              "due",
              "pending",
              "accepted",
              "running",
              "completed",
              "failed",
              "unavailable",
              "uncertain",
              "skipped",
              "coalesced",
            ]),
            piEntryId: z.string().max(160).nullable(),
            createdAt: z.string().datetime(),
            completedAt: z.string().datetime().nullable(),
            lastError: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

const ManagedCapabilitySchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["cli", "mcp"]),
    displayName: z.string().min(1).max(120),
    description: z.string().max(2000),
    configReference: z.string().max(300),
    relatedSkillIds: z.array(z.string().max(120)).max(100),
    credentialConfigured: z.boolean(),
    credentialBinding: z.enum([
      "not_configured",
      "environment_reference",
      "external_configuration",
      "manual_pi_binding_required",
    ]),
    verification: z
      .object({
        state: z.enum(["needs_check", "verified", "failed"]),
        checkedAt: z.string().datetime().nullable(),
        summary: z.string().max(500).nullable(),
      })
      .strict(),
    connectionState: z
      .enum([
        "client_open",
        "not_connected",
        "not_reported",
        "not_configured",
        "disabled",
        "starting",
        "connecting",
        "connected",
        "disconnected",
        "needs-auth",
        "failed",
        "closed",
      ])
      .optional(),
    loadedInSelectedChat: z.boolean().nullable(),
  })
  .strict();

export const PinnedResultSchema = z
  .object({
    pinId: z.string().uuid(),
    title: z.string().min(1).max(120),
    value: z.string().max(200),
    detail: z.string().max(300).optional(),
    condition: z.string().max(200).optional(),
    source: z.enum(["api", "routine", "answer"]),
    site: z.string().max(200).optional(),
    operation: z.string().max(200).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    chatId: ChatIdSchema.optional(),
    routineId: z.string().uuid().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    checkedAt: z.string().datetime().nullable(),
    refreshMinutes: z.number().int().positive().max(1440).optional(),
    needsYou: z.boolean().optional(),
    error: z.string().max(500).optional(),
    history: z
      .array(z.object({ at: z.string().datetime(), value: z.string().max(200) }).strict())
      .max(12),
  })
  .strict();

export const ManagementSnapshotSchema = z
  .object({
    chats: z.array(ChatSummarySchema).max(100),
    routines: z.array(ManagementRoutineSchema).max(100),
    pins: z.array(PinnedResultSchema).max(50),
    capabilityRevision: z.number().int().nonnegative(),
    capabilities: z.array(ManagedCapabilitySchema).max(100),
    resources: EffectivePiResourcesSchema.nullable(),
    resourceError: z.string().max(300).nullable(),
  })
  .strict();

export type ManagementSnapshotDto = z.infer<typeof ManagementSnapshotSchema>;
