import { z } from "zod";
import { ChatIdSchema, HelloAckSchema } from "@pippin/protocol";

const ConnectionGrantSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const DevConnectRequestSchema = z
  .object({
    kind: z.literal("pippin.dev.connect"),
    connectionGrant: ConnectionGrantSchema,
  })
  .strict();

export const DevConnectResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      acknowledgement: HelloAckSchema.extend({ role: z.literal("extension-executor") }),
    })
    .strict(),
  z.object({ ok: z.literal(false), code: z.string().max(80) }).strict(),
]);

export type DevConnectRequest = z.infer<typeof DevConnectRequestSchema>;
export type DevConnectResponse = z.infer<typeof DevConnectResponseSchema>;

export const DevOpenChatRequestSchema = z
  .object({
    kind: z.literal("pippin.dev.open-chat"),
    chatId: ChatIdSchema,
    connectionGrant: ConnectionGrantSchema,
    targetWindowId: z.number().int().nonnegative().optional(),
    reuseCurrentTab: z.boolean().optional(),
  })
  .strict();

export const DevStoreGrantRequestSchema = z
  .object({
    kind: z.literal("pippin.dev.store-grant"),
    connectionGrant: ConnectionGrantSchema,
  })
  .strict();

export const DevGetPageGrantRequestSchema = z
  .object({ kind: z.literal("pippin.dev.get-page-grant") })
  .strict();

export const DevTakeChatGrantRequestSchema = z
  .object({ kind: z.literal("pippin.dev.take-chat-grant"), chatId: ChatIdSchema })
  .strict();

export const DevOpenChatResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), focusedExisting: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), code: z.string().max(80) }).strict(),
]);

export const DevPageGrantResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), connectionGrant: ConnectionGrantSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.string().max(80) }).strict(),
]);

export const DevStoreGrantResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), code: z.string().max(80) }).strict(),
]);

export const DevTakeChatGrantResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), connectionGrant: ConnectionGrantSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.string().max(80) }).strict(),
]);

export const DevExtensionRequestSchema = z.discriminatedUnion("kind", [
  DevConnectRequestSchema,
  DevOpenChatRequestSchema,
  DevStoreGrantRequestSchema,
  DevGetPageGrantRequestSchema,
  DevTakeChatGrantRequestSchema,
]);
