import type { PiSessionInput } from "./pi-session-input.js";
export type { PiBrowserContextRecord, PiSessionInput } from "./pi-session-input.js";
import type {
  PiThreadDeliveryEvent,
  PiThreadDeliveryEvidence,
  PiThreadMessageAcceptance,
  PiThreadMessageInput,
} from "./thread-coordination.js";
import type { PiDetachedForkEvidence } from "./thread-coordination.js";
import type {
  EffectivePiResources,
  PiRoutineInvocation,
  PiRoutineRunEvidence,
  PiRoutineRunEvent,
} from "./durable-work.js";
import type { PiContentBlock, PiJsonValue } from "./pi-content.js";
export type { PiContentBlock, PiJsonValue } from "./pi-content.js";
import type {
  PiExtensionUiNotice,
  PiExtensionUiRequest,
  PiSessionEventListener,
  PiSlashCommand,
  PiTreeEntry,
} from "./pi-session-ui.js";
export type {
  PiExtensionUiNotice,
  PiExtensionUiRequest,
  PiSessionEvent,
  PiSessionEventListener,
  PiSlashCommand,
  PiTreeEntry,
} from "./pi-session-ui.js";
export type ChatId = string & { readonly __chatId: unique symbol };
export type ActivationId = string & { readonly __activationId: unique symbol };

export type ChatStatus = "draft" | "creating" | "ready" | "failed" | "unavailable";

export interface PiSessionReference {
  sessionId: string;
  sessionFile: string;
}

export interface ChatRecord {
  chatId: ChatId;
  title: string;
  projectId: string | null;
  pinned: boolean;
  archived: boolean;
  workingDirectory: string;
  status: ChatStatus;
  activationId: ActivationId | null;
  piReference: PiSessionReference | null;
  piMaterialized: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  chatId: ChatId;
  title: string;
  projectId: string | null;
  pinned: boolean;
  archived: boolean;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatCatalogItem extends ChatSummary {
  matchExcerpt?: string;
}

export interface ChatMetadataPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface PiTranscriptMatch {
  entryId: string;
  role: "user" | "assistant";
  excerpt: string;
}

export interface PiAvailableModel {
  provider: string;
  id: string;
  name: string;
}

export interface PiModelOption extends PiAvailableModel {
  thinkingLevels: readonly string[];
  defaultThinkingLevel: string;
}

export interface PiModelCatalog {
  defaultModel: PiAvailableModel | null;
  models: readonly PiModelOption[];
}

export interface PiSessionControlState {
  effectiveModel: PiAvailableModel | null;
  availableModels: readonly PiModelOption[];
  thinkingLevel: string;
  availableThinkingLevels: readonly string[];
  steeringQueue: readonly string[];
  followUpQueue: readonly string[];
  active: boolean;
}

export interface PiAttachment {
  name: string;
  mimeType: string;
  data: string;
  byteLength: number;
}

export interface PiTreeNavigationResult {
  entryId: string;
  cancelled: boolean;
  editorText: string | null;
}

export type PiMessageEditResult =
  | {
      status: "ready";
      entryId: string;
      editorText: string;
      attachments: readonly PiAttachment[];
      notice: "text_attachments_remain_inline" | null;
    }
  | { status: "cancelled"; entryId: string }
  | {
      status: "unsupported";
      entryId: string;
      reason:
        | "not_user_message"
        | "text_exceeds_composer_limit"
        | "image_attachment_not_supported"
        | "image_attachment_limit_exceeded";
    };

export interface ChatEventCursor {
  epoch: string;
  revision: number;
}

export interface ChatViewSnapshot {
  chat: ChatSummary;
  runState: PiRunState;
  contextUsage: PiContextUsage | null;
  entries: readonly PiEntryProjection[];
  omittedEntryCount: number;
}

export interface PiContextUsage {
  tokens: number | null;
  availableTokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type PiEntryCategory = "message" | "metadata" | "branch" | "other";

export interface PiEntrySummary {
  entryId: string;
  parentEntryId: string | null;
  category: PiEntryCategory;
}

export type PiMessageRole = "user" | "assistant" | "tool" | "custom";
export type PiStopReason =
  "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface PiMessageProjection {
  role: PiMessageRole;
  content: readonly PiContentBlock[];
  stopReason?: PiStopReason;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  nestedCalls?: PiNestedCallsProjection;
  changeDiff?: string;
}

export interface PiNestedCallsProjection {
  complete: boolean;
  calls: readonly PiNestedCallProjection[];
}

export interface PiNestedCallProjection {
  id: string;
  name: string;
  arguments?: { readonly [key: string]: PiJsonValue };
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}

export interface PiEntryProjection extends PiEntrySummary {
  timestamp: string;
  message: PiMessageProjection | null;
}

export type PiRunState = "idle" | "running-unconfirmed" | "uncertain" | "needs_attention";

export interface PiSessionSnapshot {
  reference: PiSessionReference;
  workingDirectory: string;
  entries: readonly PiEntryProjection[];
  materialized: boolean;
  active: boolean;
  runState: PiRunState;
  contextUsage: PiContextUsage | null;
}

export type PiForkEntryCheck =
  | { supported: true }
  | {
      supported: false;
      reason: "chat_not_ready" | "entry_not_found" | "branch_without_assistant";
    };

export interface PiSessionHandle {
  readToolImage?(toolCallId: string, index: number): { mimeType: string; bytes: Uint8Array };
  readonly reference: PiSessionReference;
  submit(input: PiSessionInput | string): Promise<void>;
  queue(input: PiSessionInput, mode: "followUp" | "steer"): Promise<void>;
  editQueue?(input: {
    mode: "followUp" | "steer";
    index: number;
    action: "delete" | "edit" | "up" | "down" | "steer";
    text?: string | undefined;
    steering: string[];
    followUp: string[];
  }): void;
  abort(): Promise<void>;
  controls(): PiSessionControlState;
  setModel(provider: string, id: string): Promise<void>;
  setThinkingLevel(level: string): void;
  snapshot(): PiSessionSnapshot;
  subscribe(listener: PiSessionEventListener): () => void;
  deliverThreadMessage(input: PiThreadMessageInput): Promise<PiThreadMessageAcceptance>;
  findThreadDelivery(deliveryId: string): PiThreadDeliveryEvidence;
  subscribeThreadDelivery(listener: (event: PiThreadDeliveryEvent) => void): () => void;
  invokeRoutine(input: PiRoutineInvocation): Promise<{ piEntryId: string }>;
  findRoutineRun(runId: string): PiRoutineRunEvidence;
  subscribeRoutineRuns(listener: (event: PiRoutineRunEvent) => void): () => void;
  effectiveResources(): EffectivePiResources;
  tree(): readonly PiTreeEntry[];
  slashCommands(): readonly PiSlashCommand[];
  navigateTree(entryId: string): Promise<PiTreeNavigationResult>;
  editMessage(entryId: string): Promise<PiMessageEditResult>;
  compact(customInstructions?: string): Promise<void>;
  extensionUiSnapshot(): {
    dialogs: readonly PiExtensionUiRequest[];
    notices: readonly PiExtensionUiNotice[];
  };
  answerExtensionUi(requestId: string, value: string | boolean | null): boolean;
  reloadResources(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenPiSessionInput {
  chatId: ChatId;
  activationId: ActivationId;
  workingDirectory: string;
  reference: PiSessionReference | null;
  materialized: boolean;
}
export interface PiSessionPort {
  prepareResources?(workingDirectory: string): Promise<void>;
  getModelCatalog(): Promise<PiModelCatalog>;
  /** Forget the cached catalog, e.g. after the user signs in to a provider. */
  invalidateModelCatalog?(): void;
  /** Pi's agent directory (auth.json, settings.json) this port reads; undefined means Pi's default. */
  readonly modelAgentDirectory?: string | undefined;
  /** One completion with the model new chats use (for other extensions the user allowed). */
  completeText?(
    system: string,
    messages: { role: string; content: string }[],
    choice?: { model?: string; thinking?: string },
  ): Promise<string>;
  openOrCreate(input: OpenPiSessionInput): Promise<PiSessionHandle>;
  searchTranscript(
    reference: PiSessionReference,
    workingDirectory: string,
    query: string,
  ): Promise<PiTranscriptMatch | undefined>;
  forkFromEntry(input: {
    reference: PiSessionReference;
    workingDirectory: string;
    entryId: string;
    targetChatId: ChatId;
  }): Promise<PiSessionReference>;
  inspectForkEntry(input: {
    reference: PiSessionReference;
    workingDirectory: string;
    entryId: string;
  }): PiForkEntryCheck;
  findDetachedFork(input: {
    sourceReference: PiSessionReference;
    workingDirectory: string;
    entryId: string;
    targetChatId: ChatId;
  }): PiDetachedForkEvidence;
}

export class PiSessionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiSessionUnavailableError";
  }
}

export type { ChatStore } from "./chat-store-contract.js";

export function asChatId(value: string): ChatId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Chat ID must be a UUID.");
  }
  return value as ChatId;
}

export function asActivationId(value: string): ActivationId {
  return asChatId(value) as unknown as ActivationId;
}
