import { z } from "zod";
import { ProtocolVersionSchema } from "./handshake.js";

export const CoreDiscoverySchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    endpoint: z.string().regex(/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/core\/v1$/),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    pid: z.number().int().positive(),
  })
  .strict();
export const CoreHelloSchema = z
  .object({
    kind: z.literal("core.hello"),
    protocolVersion: ProtocolVersionSchema,
    clientId: z.string().uuid(),
    surface: z.enum(["orb", "desktop", "development"]),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const CoreAttentionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("core.attention.watch") }).strict(),
  z
    .object({
      kind: z.literal("core.attention.read"),
      chatId: z.string().uuid(),
      completionId: z.string().uuid().nullable(),
      viewId: z.string().uuid(),
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("core.attention.claim"),
      chatId: z.string().uuid(),
      completionId: z.string().uuid(),
    })
    .strict(),
]);
export const CoreAttentionSnapshotSchema = z
  .object({
    kind: z.literal("core.attention.snapshot"),
    chats: z.array(
      z
        .object({
          chatId: z.string().uuid(),
          working: z.boolean(),
          completionId: z.string().uuid().nullable(),
          unread: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const CoreAttentionClaimSchema = z
  .object({
    kind: z.literal("core.attention.claimed"),
    chatId: z.string().uuid(),
    completionId: z.string().uuid(),
    granted: z.boolean(),
  })
  .strict();
export type CoreDiscovery = z.infer<typeof CoreDiscoverySchema>;
export type CoreAttentionRequest = z.infer<typeof CoreAttentionRequestSchema>;
