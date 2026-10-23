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
    surface: z.enum(["orb", "desktop", "development", "cli"]),
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
    /** For the notification: the chat's title and what it found, so it says what happened. */
    title: z.string().max(120).optional(),
    summary: z.string().max(200).optional(),
  })
  .strict();
/** A watcher's check passed: shown at once as a notification, before its agent run starts. */
export const CoreAttentionAlertSchema = z
  .object({
    kind: z.literal("core.attention.alert"),
    alertId: z.string().uuid(),
    chatId: z.string().uuid(),
    title: z.string().max(120),
    message: z.string().max(300),
  })
  .strict();
export type CoreAttentionAlert = z.infer<typeof CoreAttentionAlertSchema>;
export type CoreDiscovery = z.infer<typeof CoreDiscoverySchema>;
export type CoreAttentionRequest = z.infer<typeof CoreAttentionRequestSchema>;

/** A local client (the Aeon CLI/MCP) asks Core to show a chat as a tab in the connected Chrome. */
export const CoreOpenChatRequestSchema = z
  .object({
    kind: z.literal("core.chat.open"),
    chatId: z.string().uuid(),
    active: z.boolean().optional(),
  })
  .strict();
export const CoreOpenChatReplySchema = z
  .object({
    kind: z.literal("core.chat.opened"),
    chatId: z.string().uuid(),
    browsers: z.number().int().nonnegative(),
  })
  .strict();
/** Core asks the extension to open (or reuse) a chat tab, in the background unless active. */
export const NativeOpenChatSchema = z
  .object({
    kind: z.literal("native.chat.open"),
    chatId: z.string().uuid(),
    active: z.boolean(),
  })
  .strict();

/** A local client (the Aeon MCP) lists or calls the chat tools (browser_code, crawl, ...). */
export const CoreToolRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("core.tool.list"), requestId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal("core.tool.call"),
      requestId: z.string().uuid(),
      tool: z.enum(["browser_code", "browser_tabs", "crawl", "site_api", "extract", "chat_review"]),
      session: z.string().min(1).max(100),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type CoreToolRequest = z.infer<typeof CoreToolRequestSchema>;

/**
 * Aeon's agent settings, read or changed from outside the settings page (the Aeon CLI). Screen
 * recorders (Aperture) switch these on for a recording and restore them after; keep the names.
 */
export const AgentSettingsSchema = z
  .object({
    agentInFront: z.boolean(),
    hideAgentCursor: z.boolean(),
    agentTabView: z.enum(["split", "thumbnails"]),
  })
  .strict();
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
/** A local client reads (no `set`) or changes the agent settings in every connected Chrome. */
export const CoreSettingsRequestSchema = z
  .object({
    kind: z.literal("core.settings"),
    requestId: z.string().uuid(),
    set: AgentSettingsSchema.partial().optional(),
  })
  .strict();
/** Core asks the extension for its agent settings, applying `set` first. */
export const NativeSettingsRequestSchema = z
  .object({
    kind: z.literal("native.settings"),
    requestId: z.string().uuid(),
    set: AgentSettingsSchema.partial().optional(),
  })
  .strict();
export const NativeSettingsReplySchema = z
  .object({
    kind: z.literal("native.settings.result"),
    requestId: z.string().uuid(),
    settings: AgentSettingsSchema,
  })
  .strict();
