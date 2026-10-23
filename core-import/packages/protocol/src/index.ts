// Aeon's messages, on top of the browser engine's own (re-exported here).
export * from "@browser-use-extension/protocol";
export {
  ClientRoleSchema,
  HelloAckSchema,
  HelloRejectionSchema,
  HelloSchema,
  ProtocolHandshakeMessageSchema,
  ProtocolVersionSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type ClientRole,
  type Hello,
  type HelloAck,
  type HelloRejection,
  type ProtocolHandshakeMessage,
  type ProtocolVersion,
} from "./handshake.js";
export {
  ChatEventCursorSchema,
  ChatEventSchema,
  ChatIdSchema,
  ChatCatalogItemSchema,
  ChatStatusSchema,
  ChatSummarySchema,
  ChatViewSnapshotSchema,
  EffectivePiResourcesSchema,
  HomeManagementSnapshotSchema,
  HomeRoutineCardSchema,
  ManagementSnapshotSchema,
  PiExtensionUiNoticeSchema,
  PiExtensionUiRequestSchema,
  PiAttachmentSchema,
  PiSlashCommandSchema,
  PiTreeEntrySchema,
  PiUiSnapshotSchema,
  type EffectivePiResourcesDto,
  type HomeManagementSnapshotDto,
  type HomeRoutineCardDto,
  type ManagementSnapshotDto,
  type PiUiSnapshotDto,
  type PiAttachmentDto,
  PiEntrySchema,
  PiRunStateSchema,
  PiSessionEventSchema,
  type ChatEventCursorDto,
  type ChatEventDto,
  type ChatCatalogItemDto,
  type ChatSummaryDto,
  type ChatViewSnapshotDto,
  type PiEntryDto,
  type PiContentBlockDto,
  type PiMessageDto,
  type PiSessionEventDto,
} from "./chat-dto.js";
export { PiModelCatalogSchema, type PiModelCatalogDto } from "./model-catalog-dto.js";
export {
  ChatCloseViewRequestSchema,
  ChatCommandRequestSchema,
  ChatEventMessageSchema,
  ChatResumedMessageSchema,
  ChatSnapshotMessageSchema,
  ChatSubscriptionFailedMessageSchema,
  ChatSubscribeRequestSchema,
  ChatViewClosedMessageSchema,
  DaemonUiRequestSchema,
  PingRequestSchema,
  PongMessageSchema,
  DaemonUiResponseSchema,
  type ChatCommandRequest,
  type DaemonUiRequest,
  type DaemonUiResponse,
} from "./chat-messages.js";
export * from "./image-asset.js";

export { ProjectSchema, type ProjectDto } from "./projects.js";

export * from "./core-client.js";
export {
  CompanionRequestSchema,
  CompanionResultSchema,
  type CompanionRequest,
  type CompanionResult,
} from "./companion.js";
