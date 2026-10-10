import { useWallpaper } from "./wallpaper-settings.js";
import type { ReactElement } from "react";
import { PendingWork } from "./pending-work.js";
import { HomeStart } from "./home-start.js";
import type { ChatSurfaceProps } from "./chat-surface.js";
export function EmptyChatStart(props: ChatSurfaceProps): ReactElement {
  useWallpaper();
  const controls = props.composer.controls;
  return (
    <div className="home-main empty-chat-home" data-screen="new-tab">
      <HomeStart
        active={[]}
        props={{
          modelCatalog: controls
            ? { models: controls.availableModels, defaultModel: controls.effectiveModel }
            : null,
          chatId: props.chatId,
          browserContext: props.composer.browserContext,
          onRemoveContext: props.composer.onRemoveBrowserContext,
          projectName: props.composer.projectName ?? null,
          projectId: props.chats.find((chat) => chat.chatId === props.chatId)?.projectId ?? null,
          homeRoutines: [],
          openChatIds: new Set(),
          onReadAttachments: async (files) => [
            ...((await props.composer.onReadDraftAttachments?.(files)) ?? []),
          ],
          onAsk: (text, model, thinking, files = []) => {
            if (props.composer.onStart) void props.composer.onStart(text, model, thinking, files);
            else void props.composer.onSend(text, "followUp", files);
          },
          onOpenChat: props.onSelectChat,
          onCatalog: () => {
            location.assign("home.html?view=chats");
          },
          onManageRoutines: () => {
            location.assign("home.html?view=routines");
          },
        }}
      />
      {(props.composer.running || props.composer.connecting) && (
        <PendingWork connecting={Boolean(props.composer.connecting)} />
      )}
    </div>
  );
}
