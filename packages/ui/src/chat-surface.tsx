import { EmptyChatStart } from "./empty-chat-start.js";
import { SidebarResizer } from "./sidebar-resizer.js";
import type { ChatSummaryDto, PiUiSnapshotDto } from "@pippin/protocol";
import { AnnotationProvider } from "./transcript-annotations.js";
import { useState, type ReactElement } from "react";
import type { ManagementSection } from "./management-types.js";
import { invokePiCommand } from "./pi-native-command.js";
import { ChatNavigation } from "./chat-navigation.js";
import { ChatComposer, type ChatComposerProps } from "./chat-composer.js";
import { ChatSidebar } from "./chat-sidebar.js";
import { ChatTranscript } from "./chat-transcript.js";
import { LoadedResources, type LoadedResourcesState } from "./loaded-resources.js";
import type { TranscriptRow } from "./transcript-model.js";
import { PiSessionPanel } from "./pi-session-panel.js";
import { ExtensionDialogs } from "./extension-dialogs.js";
import { ToolImageContext, type ToolImageLoader } from "./tool-images.js";

export interface ChatSurfaceProps {
  loadToolImage?: ToolImageLoader | undefined;
  developmentFixture: boolean;
  chatId: string;
  title: string;
  connection: { label: string; state: "connecting" | "connected" | "error" };
  notice: string;
  rows: readonly TranscriptRow[];
  chats: readonly ChatSummaryDto[];
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
  const [section, setSection] = useState<ManagementSection | null>(null);
  const openSection = (next: ManagementSection): void => {
    if (!props.sidebarOpen) props.onToggleSidebar();
    setSection(section === next ? null : next);
  };
  return (
    <div
      className="app-shell"
      data-chat-id={props.chatId}
      data-sidebar-open={String(props.sidebarOpen)}
    >
      <span id="connection-state" hidden data-state={props.connection.state}>
        {props.connection.label}
      </span>
      <ChatNavigation {...props} onSettings={() => openSection("settings")} />
      <ChatSidebar
        developmentFixture={props.developmentFixture}
        chats={props.chats}
        currentChatId={props.chatId}
        query={props.sidebarQuery}
        open={props.sidebarOpen}
        onQuery={props.onSidebarQuery}
        onOpen={(id) => {
          setSection(null);
          props.onSelectChat(id);
        }}
        onClose={props.onCloseSidebar}
        onNew={props.onNewChat}
        {...(props.onPinChat ? { onPin: props.onPinChat } : {})}
        {...(props.onDeleteChat ? { onDelete: props.onDeleteChat } : {})}
        onManagement={openSection}
        managementSection={section ?? undefined}
      />
      <SidebarResizer open={props.sidebarOpen} onCollapse={props.onCloseSidebar} />
      <ToolImageContext.Provider value={props.loadToolImage}>
        {section && (
          <main className="chat-main">
            <iframe
              className="chat-management-frame"
              title={section}
              src={"home.html?embedded=1&view=" + section + "&chatId=" + props.chatId}
            />
          </main>
        )}
        <div className="chat-content-host" hidden={Boolean(section)}>
          <AnnotationProvider key={props.chatId}>
            <ChatContent {...props} />
          </AnnotationProvider>
        </div>
      </ToolImageContext.Provider>
    </div>
  );
}

function ChatContent(props: ChatSurfaceProps): ReactElement {
  if (isEmptyChat(props)) return <EmptyChatStart {...props} />;
  return (
    <main className="chat-main">
      {props.notice && (
        <div className="sync-notice" role="status" aria-live="polite" data-error="true">
          {props.notice}
        </div>
      )}
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
              actionsDisabled={
                Boolean(props.transcriptActionsDisabled) || props.composer.running || props.piUiBusy
              }
              {...(props.onEditMessage ? { onEditEntry: props.onEditMessage } : {})}
              {...(props.onBranchMessage ? { onBranchEntry: props.onBranchMessage } : {})}
            />
          ) : (
            <section className="welcome" aria-label="New Chat">
              <p>What would you like to work on?</p>
            </section>
          )}
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
  return !props.rows.length && !props.resourcesOpen && !props.notice && !props.composer.running;
}

function showTranscript(props: ChatSurfaceProps): boolean {
  return Boolean(props.rows.length || props.composer.running);
}
