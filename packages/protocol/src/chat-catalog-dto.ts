import { z } from "zod";

export const ChatIdSchema = z.string().uuid();
export const ChatStatusSchema = z.enum(["draft", "creating", "ready", "failed", "unavailable"]);
export const ChatSummarySchema = z
  .object({
    chatId: ChatIdSchema,
    title: z.string().min(1).max(120),
    projectId: z.string().min(1).max(200).nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    status: ChatStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const ChatCatalogItemSchema = ChatSummarySchema.extend({
  matchExcerpt: z.string().max(240).optional(),
}).strict();
export const EffectivePiResourcesSchema = z
  .object({
    chatId: ChatIdSchema,
    sessionState: z.enum(["not_started", "loaded"]),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    mcpServers: z
      .array(
        z
          .object({
            name: z.string().max(120),
            enabled: z.boolean(),
            state: z.enum([
              "disabled",
              "starting",
              "connecting",
              "connected",
              "disconnected",
              "needs-auth",
              "failed",
              "closed",
            ]),
            toolCount: z.number().int().nonnegative().max(10_000),
            resourceCount: z.number().int().nonnegative().max(10_000),
          })
          .strict(),
      )
      .max(100),
    skills: z
      .array(
        z
          .object({
            name: z.string().max(120),
            description: z.string().max(2000),
            source: z.string().max(300),
          })
          .strict(),
      )
      .max(200),
    extensions: z
      .array(
        z
          .object({ path: z.string().max(1000), tools: z.array(z.string().max(120)).max(64) })
          .strict(),
      )
      .max(100),
    extensionErrors: z
      .array(z.object({ path: z.string().max(1000), error: z.string().max(500) }).strict())
      .max(50),
    tools: z
      .array(
        z
          .object({
            name: z.string().max(120),
            description: z.string().max(1000),
            active: z.boolean(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export type EffectivePiResourcesDto = z.infer<typeof EffectivePiResourcesSchema>;
