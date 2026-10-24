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
/** A local client (the Aeon CLI/MCP) stops a running chat. */
export const CoreChatStopRequestSchema = z
  .object({
    kind: z.literal("core.chat.stop"),
    requestId: z.string().uuid(),
    chatId: z.string().uuid(),
  })
  .strict();
export const CoreChatStopReplySchema = z
  .object({
    kind: z.literal("core.chat.stopped"),
    requestId: z.string().uuid(),
    chatId: z.string().uuid(),
    stopped: z.boolean(),
    error: z.string().max(2000).optional(),
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
      tool: z.enum([
        "browser_code",
        "browser_tabs",
        "crawl",
        "site_mapper",
        "extract",
        "chat_review",
      ]),
      session: z.string().min(1).max(100),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type CoreToolRequest = z.infer<typeof CoreToolRequestSchema>;

/** A local client (the Aeon CLI) runs browser code in the user's Chrome, through Core. */
export const CoreBrowserRunRequestSchema = z
  .object({
    kind: z.literal("core.browser.run"),
    requestId: z.string().uuid(),
    code: z.string().min(1).max(16000),
    session: z.string().min(1).max(100),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
  })
  .strict();
export const CoreBrowserRunResultSchema = z
  .object({
    kind: z.literal("core.browser.result"),
    requestId: z.string().uuid(),
    value: z.unknown().optional(),
    output: z.string().max(200000).optional(),
    error: z.string().max(20000).optional(),
    detail: z.string().max(20000).optional(),
  })
  .strict();
export type CoreBrowserRunRequest = z.infer<typeof CoreBrowserRunRequestSchema>;
export type CoreBrowserRunResult = z.infer<typeof CoreBrowserRunResultSchema>;

/** A local client (the Aeon CLI) uses the user's default model for a tool-calling completion. */
export const CoreModelCompleteRequestSchema = z
  .object({
    kind: z.literal("core.model.complete"),
    requestId: z.string().uuid(),
    systemPrompt: z.string().min(1).max(20000),
    messages: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    tools: z.array(z.record(z.string(), z.unknown())).max(50),
  })
  .strict();
export const CoreModelCompleteResultSchema = z
  .object({
    kind: z.literal("core.model.result"),
    requestId: z.string().uuid(),
    message: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(20000).optional(),
  })
  .strict();
export type CoreModelCompleteRequest = z.infer<typeof CoreModelCompleteRequestSchema>;
export type CoreModelCompleteResult = z.infer<typeof CoreModelCompleteResultSchema>;

/** A local client (the Aeon CLI) reads or changes the sites agents may not use. */
export const CoreBlockedSitesRequestSchema = z
  .object({
    kind: z.literal("core.blocked-sites"),
    requestId: z.string().uuid(),
    action: z.enum(["read", "add", "remove"]),
    site: z.string().min(1).max(200).optional(),
  })
  .strict();
export const CoreBlockedSitesResultSchema = z
  .object({
    kind: z.literal("core.blocked-sites.result"),
    requestId: z.string().uuid(),
    sites: z.array(z.string().max(200)).max(2000),
    error: z.string().max(2000).optional(),
  })
  .strict();
export type CoreBlockedSitesRequest = z.infer<typeof CoreBlockedSitesRequestSchema>;
export type CoreBlockedSitesResult = z.infer<typeof CoreBlockedSitesResultSchema>;
/** Core asks the extension for its blocked sites, changing them first if asked. */
export const NativeBlockedSitesRequestSchema = z
  .object({
    kind: z.literal("native.blocked-sites"),
    requestId: z.string().uuid(),
    action: z.enum(["read", "add", "remove", "replace"]),
    site: z.string().min(1).max(200).optional(),
    /** replace: the whole list, as browserkit's site-rules.json has it. */
    sites: z.array(z.string().max(200)).max(2000).optional(),
  })
  .strict();
export const NativeBlockedSitesReplySchema = z
  .object({
    kind: z.literal("native.blocked-sites.result"),
    requestId: z.string().uuid(),
    sites: z.array(z.string().max(200)).max(2000),
    error: z.string().max(2000).optional(),
  })
  .strict();

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
