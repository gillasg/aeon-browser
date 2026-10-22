import { z } from "zod";
import {
  ChatIdSchema,
  PageGrantScopeSchema,
  ProtocolVersionSchema,
  PiAttachmentSchema,
} from "@aeon/protocol";

export const NativePageGrantRequestSchema = z
  .object({
    kind: z.literal("aeon.native.page-grant"),
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
    kind: z.literal("aeon.native.open-chat"),
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
    kind: z.literal("aeon.native.take-initial-submit"),
    chatId: ChatIdSchema,
  })
  .strict();

export const NativeClaimBrowserContextSubmitRequestSchema = z
  .object({
    kind: z.literal("aeon.native.claim-browser-context-submit"),
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
  z.object({ kind: z.literal("aeon.native.current-page") }).strict(),
  z.object({ kind: z.literal("aeon.native.health") }).strict(),
  z.object({ kind: z.literal("aeon.native.list-context-tabs") }).strict(),
  z
    .object({
      kind: z.literal("aeon.native.capture-page"),
      tabId: z.number().int().nonnegative(),
    })
    .strict(),
  NativePageGrantRequestSchema,
  NativeOpenChatRequestSchema,
  NativeTakeInitialSubmitRequestSchema,
  NativeClaimBrowserContextSubmitRequestSchema,
]);

/** What a page shows when it can't connect: which link is down and how to fix it. */
export function pageGrantErrorMessage(code: string): string {
  switch (code) {
    case "WORKER_UNREACHABLE":
      return "Aeon's background worker isn't running. Open chrome://extensions and click Reload on Aeon; its Errors button shows why it stopped.";
    case "WORKER_DEGRADED":
      return "Part of Aeon's background worker failed to start. Open chrome://extensions and click Reload on Aeon; its Errors button shows what failed.";
    case "HOST_MISSING":
      return "Aeon's native host isn't installed, so Chrome can't reach the daemon. Run Aeon's setup again.";
    case "HOST_CONFIG_INVALID":
      return "Aeon's native host registration is broken. Run Aeon's setup again to repair it.";
    case "DAEMON_OFFLINE":
      return "Aeon's daemon isn't answering. It restarts by itself within a minute; if it doesn't, sign out of Windows and back in, or run start-daemon.ps1 in %LOCALAPPDATA%\\Aeon. Retrying…";
    case "CONNECTION_TIMEOUT":
      return "Aeon's daemon is starting or busy and didn't answer in time. Retrying…";
    case "UPDATE_REQUIRED":
      return "Aeon and its daemon are different versions. Update Aeon, then reload it in chrome://extensions.";
    default:
      return "Aeon couldn't connect to its daemon. Retrying…";
  }
}
