import { z } from "zod";
import {
  ChatIdSchema,
  PageGrantScopeSchema,
  ProtocolVersionSchema,
  PiAttachmentSchema,
} from "@pippin/protocol";

export const NativePageGrantRequestSchema = z
  .object({
    kind: z.literal("pippin.native.page-grant"),
    pageInstanceId: z.string().uuid(),
    scope: PageGrantScopeSchema,
  })
  .strict();

export const NativePageGrantResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      endpoint: z.string().url(),
      connectionGrant: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: z.number().int().positive(),
      protocolVersion: ProtocolVersionSchema,
      clientInstanceId: z.string().uuid(),
      browserRunId: z.string().uuid(),
      pageInstanceId: z.string().uuid(),
      scope: PageGrantScopeSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum([
        "HOST_MISSING",
        "HOST_CONFIG_INVALID",
        "DAEMON_OFFLINE",
        "CONNECTION_TIMEOUT",
        "UPDATE_REQUIRED",
        "INVALID_SENDER",
        "INVALID_SCOPE",
        "BOOTSTRAP_UNAVAILABLE",
      ]),
    })
    .strict(),
]);

export const NativeOpenChatRequestSchema = z
  .object({
    kind: z.literal("pippin.native.open-chat"),
    chatId: ChatIdSchema,
    targetWindowId: z.number().int().nonnegative().optional(),
    reuseCurrentTab: z.boolean().optional(),
    initialSubmit: z
      .object({
        requestId: z.string().uuid(),
        text: z.string().trim().min(1).max(50_000),
        model: z
          .object({ provider: z.string().min(1).max(120), id: z.string().min(1).max(300) })
          .strict(),
        thinkingLevel: z.string().min(1).max(40),
        attachments: z.array(PiAttachmentSchema).max(3).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const NativeTakeInitialSubmitRequestSchema = z
  .object({
    kind: z.literal("pippin.native.take-initial-submit"),
    chatId: ChatIdSchema,
  })
  .strict();

export const NativeClaimBrowserContextSubmitRequestSchema = z
  .object({
    kind: z.literal("pippin.native.claim-browser-context-submit"),
    chatId: ChatIdSchema,
    invocationId: z.string().uuid(),
  })
  .strict();

export const NativeClaimBrowserContextSubmitResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), prompt: z.string().trim().min(1).max(500) }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["INVALID_SENDER", "ALREADY_CLAIMED", "UNAVAILABLE"]),
    })
    .strict(),
]);

export const NativeTakeInitialSubmitResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      requestId: z.string().uuid(),
      text: z.string().min(1).max(50_000),
      model: z
        .object({ provider: z.string().min(1).max(120), id: z.string().min(1).max(300) })
        .strict(),
      thinkingLevel: z.string().min(1).max(40),
      attachments: z.array(PiAttachmentSchema).max(3).optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["INVALID_SENDER", "INITIAL_SUBMIT_UNAVAILABLE"]),
    })
    .strict(),
]);

export const NativeOpenChatResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), focusedExisting: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), code: z.string().max(80) }).strict(),
]);

export const NativeExtensionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pippin.native.current-page") }).strict(),
  z.object({ kind: z.literal("pippin.native.list-context-tabs") }).strict(),
  z
    .object({
      kind: z.literal("pippin.native.capture-page"),
      tabId: z.number().int().nonnegative(),
    })
    .strict(),
  NativePageGrantRequestSchema,
  NativeOpenChatRequestSchema,
  NativeTakeInitialSubmitRequestSchema,
  NativeClaimBrowserContextSubmitRequestSchema,
]);

export function pageGrantErrorMessage(code: string): string {
  switch (code) {
    case "HOST_MISSING":
      return "Aeon's native host is not installed. Run the Aeon host installer.";
    case "HOST_CONFIG_INVALID":
      return "Aeon's native host needs repair. Reinstall the Aeon host.";
    case "DAEMON_OFFLINE":
      return "Aeon's local connection is unavailable. Reconnecting…";
    case "CONNECTION_TIMEOUT":
      return "Aeon's local connection did not respond in time. Reconnecting…";
    case "UPDATE_REQUIRED":
      return "Aeon needs an update before this page can connect.";
    default:
      return "Aeon could not establish a local connection. Retrying…";
  }
}
