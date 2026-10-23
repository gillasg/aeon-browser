import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ComposerAddMenu } from "./composer-add-menu.js";
import { serializeAnnotations, useAnnotations } from "./transcript-annotations.js";
import { PiQueue } from "./pi-queue.js";
import { useMessageSendMode } from "./message-send-mode.js";
import { PromptField } from "./prompt-field.js";
import { ComposerPanels, AttachmentList } from "./composer-panels.js";
import { PageContextTray } from "./page-context-tray.js";
import type { PiBrowserContextRecord } from "@aeon/protocol";

export interface ComposerAttachment {
  name: string;
  mimeType: string;
  data: string;
  byteLength: number;
}
export interface ComposerModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
  defaultThinkingLevel: string;
}
export type EffectiveComposerModel = Pick<ComposerModel, "provider" | "id" | "name">;
export interface ComposerControls {
  effectiveModel: EffectiveComposerModel | null;
  availableModels: ComposerModel[];
  thinkingLevel: string;
  availableThinkingLevels: string[];
  steeringQueue: string[];
  followUpQueue: string[];
}
export interface PiContextUsage {
  tokens: number | null;
  availableTokens: number | null;
  contextWindow: number;
  percent: number | null;
}
export interface ChatComposerProps {
  projectName?: string | null;
  onTogglePiUi?(): void;
  piUiOpen?: boolean;
  chatId: string;
  connected: boolean;
  running: boolean;
  starting?: boolean;
  connecting?: boolean;
  preparing?: boolean;
  controls: ComposerControls | null;
  /** Why the Chat's Pi session could not start, kept until a refresh succeeds. */
  controlsError?: string | undefined;
  contextUsage?: PiContextUsage | null;
  modelLogin?: import("./connect-model-card.js").ModelLoginState;
  onManageModels?(): void;
  attachments: readonly ComposerAttachment[];
  editDraftInsertion?: { id: number; text: string };
  editNotice?: string | null;
  browserContext: PiBrowserContextRecord | null;
  commandInsertion?: { id: number; text: string };
  onSend(
    text: string,
    mode: "followUp" | "steer",
    attachments: readonly ComposerAttachment[],
  ): Promise<boolean>;
  onQueueAction?(
    mode: "followUp" | "steer",
    index: number,
    action: "delete" | "edit" | "up" | "down" | "steer",
    text?: string,
  ): Promise<void>;
  onStart?(
    text: string,
    model: ComposerModel,
    thinking: string,
    files: readonly ComposerAttachment[],
  ): Promise<boolean>;
  onReadDraftAttachments?(files: readonly File[]): Promise<readonly ComposerAttachment[]>;
  onStop(): void;
  onModel(value: ComposerModel): void;
  onThinking(value: string): void;
  onAttach(targetChatId: string, files: readonly File[]): void;
  onRemoveAttachment(index: number): void;
  onRemoveBrowserContext(): void;
}

export function ChatComposer(props: ChatComposerProps): ReactElement {
  const [mode, setMode] = useMessageSendMode();
  const panels = <ComposerPanels {...props} mode={mode} onMode={setMode} />;
  return (
    <div className="composer-dock">
      {props.editNotice && (
        <p className="composer-edit-notice" role="status">
          {props.editNotice}
        </p>
      )}
      <PiQueue controls={props.controls} onAction={props.onQueueAction} />
      <PageContextTray
        chatId={props.chatId}
        primary={props.browserContext}
        onRemove={props.onRemoveBrowserContext}
      />
      <AttachmentList
        attachments={props.attachments}
        onRemoveAttachment={props.onRemoveAttachment}
      />
      <ComposerEntry {...props} mode={mode} />
      {panels}
    </div>
  );
}

function ComposerEntry(
  props: ChatComposerProps & { mode: "followUp" | "steer"; panels?: ReactNode },
): ReactElement {
  const [text, setText] = useState("");
  const annotations = useAnnotations();
  useEffect(() => {
    if (props.commandInsertion) setText(props.commandInsertion.text);
  }, [props.commandInsertion?.id]);
  useEffect(() => {
    if (props.editDraftInsertion) setText(props.editDraftInsertion.text);
  }, [props.editDraftInsertion?.id]);
  const send = async (): Promise<void> => {
    const records = [...(annotations?.records ?? [])];
    const message = [text.trim(), serializeAnnotations(records)].filter(Boolean).join("\n\n");
    if (
      message &&
      props.connected &&
      (await props.onSend(message, props.mode, props.attachments))
    ) {
      setText("");
      annotations?.clear(records.map((record) => record.id));
    }
  };
  return (
    <form
      id="composer"
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <AttachmentPicker chatId={props.chatId} onAttach={props.onAttach} />
      <PromptField
        multiline
        value={text}
        placeholder="Reply, @ for context"
        ariaLabel="Message Aeon"
        onChange={setText}
        onFiles={(files) => props.onAttach(props.chatId, files)}
        onEnter={() => void send()}
      />
      <ComposerSendControl
        running={props.running}
        connected={props.connected}
        enabled={Boolean(text.trim() || annotations?.records.length)}
        onStop={props.onStop}
      />
      {props.panels}
    </form>
  );
}

function ComposerSendControl(props: {
  running: boolean;
  starting?: boolean;
  connected: boolean;
  enabled: boolean;
  onStop(): void;
}): ReactElement {
  return (
    <div className="composer-controls">
      {props.running ? (
        <StopButton enabled={props.connected} onStop={props.onStop} />
      ) : (
        <SendButton enabled={props.connected && props.enabled} />
      )}
    </div>
  );
}

function AttachmentPicker({
  chatId,
  onAttach,
}: {
  chatId: string;
  onAttach(targetChatId: string, files: readonly File[]): void;
}): ReactElement {
  const picker = useRef<HTMLInputElement>(null);
  const targetChatId = useRef(chatId);
  return (
    <>
      <ComposerAddMenu
        contextId={chatId}
        onFiles={() => {
          targetChatId.current = chatId;
          picker.current?.click();
        }}
      />
      <input
        ref={picker}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv,application/json,.md,.txt,.csv,.json"
        onChange={(event) => {
          onAttach(targetChatId.current, [...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

function SendButton({ enabled }: { enabled: boolean }): ReactElement {
  return (
    <button className="send-button" type="submit" aria-label="Send message" disabled={!enabled}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 15V4m0 0L5.7 8.3M10 4l4.3 4.3" />
      </svg>
    </button>
  );
}

function StopButton({ enabled, onStop }: { enabled: boolean; onStop(): void }): ReactElement {
  return (
    <button
      id="stop"
      className="send-button stop-icon-button"
      type="button"
      aria-label="Stop response"
      disabled={!enabled}
      onClick={onStop}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="5" y="5" width="10" height="10" rx="2" />
      </svg>
    </button>
  );
}
