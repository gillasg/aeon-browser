import { useState } from "react";
import { EmptyChatStart } from "./empty-chat-start.js";
import type { ChatSummaryDto, PiUiSnapshotDto } from "@aeon/protocol";
import { AnnotationProvider } from "./transcript-annotations.js";
import type { ReactElement } from "react";
import { invokePiCommand } from "./pi-native-command.js";
import { ChatNavigation } from "./chat-navigation.js";
import { ChatComposer, type ChatComposerProps } from "./chat-composer.js";
import { ChatTranscript } from "./chat-transcript.js";
import { LoadedResources, type LoadedResourcesState } from "./loaded-resources.js";
import type { TranscriptRow } from "./transcript-model.js";
import { PiSessionPanel } from "./pi-session-panel.js";
import { ExtensionDialogs } from "./extension-dialogs.js";
import { ToolImageContext, type ToolImageLoader } from "./tool-images.js";

export interface ChatSurfaceProps {
  loadToolImage?: ToolImageLoader | undefined;
  developmentFixture: boolean;
  /** The orb's box: no start page, the transcript and a small composer only. */
  compact?: boolean | undefined;
  chatId: string;
  title: string;
  connection: { label: string; state: "connecting" | "connected" | "error" };
  notice: string;
  onDismissNotice?(): void;
  /** A tab the user took over from the agent; the run waits until it is given back. */
  userControl?: { tabId: number } | null | undefined;
  onGiveBack?(tabId: number): void;
  rows: readonly TranscriptRow[];
  chats: readonly ChatSummaryDto[];
  /** Chats working right now, and those waiting for the user (the switcher's dots). */
  runningChatIds?: ReadonlySet<string> | undefined;
  needsChatIds?: ReadonlySet<string> | undefined;
  onRefreshChats?(): void;
  sidebarOpen: boolean;
  sidebarQuery: string;
  composer: ChatComposerProps;
  resourcesOpen: boolean;
  resources: LoadedResourcesState;
  piUi: PiUiSnapshotDto | null;
  piUiOpen: boolean;
  piUiBusy: boolean;
  onToggleSidebar(): void;
  onCloseSidebar(): void;
  onSidebarQuery(value: string): void;
  onSelectChat(chatId: string): void;
  transcriptActionsDisabled?: boolean;
  onEditMessage?(entryId: string): Promise<void> | void;
  onBranchMessage?(entryId: string): Promise<void> | void;
  onPinAnswer?: ((text: string) => Promise<void> | void) | undefined;
  onNewChat(): void;
  onPinChat?(chat: ChatSummaryDto): void;
  onDeleteChat?(chat: ChatSummaryDto): void;
  onToggleResources(): void;
  onRefreshResources(): void;
  onTogglePiUi(): void;
  onRefreshPiUi(): void;
  onNavigateTree(entryId: string): void;
  onInsertCommand(invocation: string): void;
  onCompact(): void;
  onAnswerExtensionUi(requestId: string, value: string | boolean | null): void;
}

export function ChatSurface(props: ChatSurfaceProps): ReactElement {
  return (
    <div className="app-shell" data-chat-id={props.chatId} data-sidebar-open="false">
      <span id="connection-state" hidden data-state={props.connection.state}>
        {props.connection.label}
      </span>
      <ChatNavigation
        onNewChat={props.onNewChat}
        switcher={{
          chats: props.chats,
          currentChatId: props.chatId,
          running: props.runningChatIds,
          needs: props.needsChatIds,
          onSelect: props.onSelectChat,
          onOpen: props.onRefreshChats,
          shortcut: true,
          icon: true,
        }}
      />
      <ToolImageContext.Provider value={props.loadToolImage}>
        <div className="chat-content-host">
          <AnnotationProvider key={props.chatId}>
            <ChatContent {...props} />
          </AnnotationProvider>
        </div>
      </ToolImageContext.Provider>
    </div>
  );
}

function ChatNotice({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss?: (() => void) | undefined;
}): ReactElement {
  return (
    <div className="sync-notice" role="status" aria-live="polite" data-error="true">
      <span>{text}</span>
      {onDismiss && (
        <button type="button" aria-label="Dismiss message" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

function ControlBar({
  tabId,
  onGiveBack,
}: {
  tabId: number;
  onGiveBack?: ((tabId: number) => void) | undefined;
}): ReactElement {
  return (
    <div className="control-bar" role="status" aria-live="polite">
      <span>You have control. The agent waits until you give it back.</span>
      <button type="button" onClick={() => onGiveBack?.(tabId)}>
        Give back
      </button>
    </div>
  );
}

export const ONE_CLICK_TEXT =
  "Save what you just did as an action for this site, so next time it runs in one click without a model.";

/** After a run that worked in the browser: offer to save it as an ability ("make it one click"). */
function OneClickOffer(props: ChatSurfaceProps): ReactElement | null {
  const [askedAt, setAskedAt] = useState(-1);
  const usedBrowser = props.rows.some((row) => row.kind === "tool-group");
  if (props.composer.running || !usedBrowser || askedAt === props.rows.length) return null;
  return (
    <div className="one-click-offer">
      <button
        type="button"
        onClick={() => {
          setAskedAt(props.rows.length);
          void props.composer.onSend(ONE_CLICK_TEXT, "followUp", []);
        }}
      >
        Make it one click
      </button>
    </div>
  );
}

function ChatBanners(props: ChatSurfaceProps): ReactElement {
  return (
    <>
      {props.notice && <ChatNotice text={props.notice} onDismiss={props.onDismissNotice} />}
      {props.userControl && (
        <ControlBar tabId={props.userControl.tabId} onGiveBack={props.onGiveBack} />
      )}
    </>
  );
}

function ChatContent(props: ChatSurfaceProps): ReactElement {
  if (isEmptyChat(props)) return <EmptyChatStart {...props} />;
  return (
    <main className="chat-main">
      <ChatBanners {...props} />
      <ChatPiOverlays {...props} />
      {props.resourcesOpen ? (
        <LoadedResources
          chatTitle={props.title}
          state={props.resources}
          onRefresh={props.onRefreshResources}
          onReturn={props.onToggleResources}
        />
      ) : (
        <>
          {showTranscript(props) ? (
            <ChatTranscript
              rows={props.rows}
              running={props.composer.running}
              starting={Boolean(props.composer.starting)}
              connecting={Boolean(props.composer.connecting)}
              preparing={Boolean(props.composer.preparing)}
              actionsDisabled={
                Boolean(props.transcriptActionsDisabled) || props.composer.running || props.piUiBusy
              }
              {...(props.onEditMessage ? { onEditEntry: props.onEditMessage } : {})}
              {...(props.onBranchMessage ? { onBranchEntry: props.onBranchMessage } : {})}
              onPinMessage={props.onPinAnswer}
            />
          ) : props.compact ? (
            <div className="transcript-wrap" />
          ) : (
            <section className="welcome" aria-label="New Chat">
              <p>What would you like to work on?</p>
            </section>
          )}
          <OneClickOffer {...props} />
          <ChatComposer
            {...props.composer}
            projectName={
              props.composer.projectName !== undefined
                ? props.composer.projectName
                : (props.chats.find((chat) => chat.chatId === props.chatId)?.projectId ?? null)
            }
            onTogglePiUi={props.onTogglePiUi}
            piUiOpen={props.piUiOpen}
          />
        </>
      )}
    </main>
  );
}

function ChatPiOverlays(props: ChatSurfaceProps): ReactElement | null {
  if (props.resourcesOpen) return null;
  return (
    <>
      {props.piUiOpen && (
        <PiSessionPanel
          snapshot={props.piUi}
          busy={props.piUiBusy}
          onRefresh={props.onRefreshPiUi}
          onClose={props.onTogglePiUi}
          onNavigate={props.onNavigateTree}
          onInsertCommand={(invocation) => {
            if (
              props.piUi?.slashCommands.find((command) => command.invocation === invocation)
                ?.kind === "builtin"
            )
              invokePiCommand(invocation, props);
            else props.onInsertCommand(invocation);
          }}
          onCompact={props.onCompact}
        />
      )}
      {props.piUi?.extensionDialogs.map((dialog) => (
        <ExtensionDialogs
          key={dialog.requestId}
          dialog={dialog}
          onAnswer={props.onAnswerExtensionUi}
        />
      ))}
      {props.piUi?.notices.map((item) => (
        <p key={item.noticeId} className="pi-extension-notice" role="status" data-type={item.type}>
          {item.message}
        </p>
      ))}
    </>
  );
}

function isEmptyChat(props: ChatSurfaceProps): boolean {
  if (props.compact) return false;
  return !props.rows.length && !props.resourcesOpen && !props.notice && !props.composer.running;
}

function showTranscript(props: ChatSurfaceProps): boolean {
  return Boolean(props.rows.length || props.composer.running);
}
