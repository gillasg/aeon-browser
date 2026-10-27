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
    /** The opt-in local command its check runs; shown so the editor can keep it. */
    checkShell: z.string().max(2000).optional(),
    /** Sites this routine may use; empty means it is not restricted. */
    sites: z.array(z.string().min(1).max(200)).max(50),
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

const PasswordManagerSchema = z
  .object({
    /** The password manager that answers sign-in requests, by name; never its keys or items. */
    provider: z.string().min(1).max(40).nullable(),
    state: z.enum(["unlocked", "locked", "not_set_up", "unavailable"]),
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

/** A saved workflow and its last run: the Automations page. */
export const ManagementWorkflowSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(120),
    steps: z.number().int().nonnegative(),
    description: z.string().max(1000).optional(),
    updatedAt: z.string().datetime(),
    /** What the workflow expects; defaults are shown in the run form. */
    inputs: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            required: z.boolean(),
            description: z.string().max(500).optional(),
            default: z.unknown().optional(),
          })
          .strict(),
      )
      .max(50),
    running: z.boolean(),
    progress: z
      .object({
        step: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        id: z.string().max(160),
        action: z.string().max(160),
      })
      .strict()
      .optional(),
    lastRun: z
      .object({
        state: z.enum(["ok", "failed", "running", "cancelled"]),
        at: z.string().datetime(),
        error: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** One named thing a site can do, for the Sites and Automations pages. */
export const ManagementAbilitySchema = z
  .object({
    name: z.string().min(1).max(200),
    site: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    kind: z.enum(["read", "write"]),
    ways: z.array(z.enum(["api", "steps", "script", "page"])).max(8),
    inputs: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            required: z.boolean(),
            description: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(50),
    stats: z
      .object({
        runs: z.number().int().nonnegative(),
        failures: z.number().int().nonnegative(),
        lastOkAt: z.string().max(60).optional(),
        lastUsedAt: z.string().max(60).optional(),
      })
      .strict()
      .optional(),
    updatedAt: z.string().max(60),
    running: z.boolean().optional(),
  })
  .strict();

/** A mapped site and what this machine knows about it: the Sites page and its sessions. */
export const ManagementSiteSchema = z
  .object({
    site: z.string().min(1).max(200),
    operations: z.number().int().nonnegative(),
    updatedAt: z.string().max(40),
    health: z.string().max(40),
    session: z.boolean(),
    sessionAccount: z.string().max(200).nullable(),
    sessionSavedAt: z.string().max(60).nullable(),
    recording: z.boolean(),
    suggestions: z.array(z.string().max(500)).max(10),
    abilities: z.array(ManagementAbilitySchema).max(100),
  })
  .strict();

/** What the last library action did, so the page can say it without another channel. */
export const ManagementActionNoteSchema = z
  .object({
    ok: z.boolean(),
    at: z.string().datetime(),
    message: z.string().max(2000),
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
    /** Which password manager signs in, and whether it is unlocked. Name and state only. */
    signIn: PasswordManagerSchema,
    /** Site abilities for the Automations page. */
    abilities: z.array(ManagementAbilitySchema).max(200).optional(),
    /** Saved workflows; deprecated by abilities. */
    workflows: z.array(ManagementWorkflowSchema).max(100).optional(),
    /** Mapped sites, with health, recipes and the stored session. */
    sites: z.array(ManagementSiteSchema).max(200).optional(),
    /** Browser chat accounts: signed-in state, account when known, transport and last test. */
    providers: z
      .array(
        z
          .object({
            id: z.string().max(40),
            name: z.string().max(80),
            host: z.string().max(200),
            signedIn: z.boolean(),
            cookies: z.number().int().nonnegative(),
            account: z.string().max(200).nullable(),
            transport: z.string().max(80),
            lastTest: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    /** The result of the last run/import/export/session action, for the page to show. */
    lastAction: ManagementActionNoteSchema.nullable().optional(),
  })
  .strict();

export type ManagementSnapshotDto = z.infer<typeof ManagementSnapshotSchema>;
export type ManagementWorkflowDto = z.infer<typeof ManagementWorkflowSchema>;
export type ManagementSiteDto = z.infer<typeof ManagementSiteSchema>;
export type ManagementAbilityDto = z.infer<typeof ManagementAbilitySchema>;
