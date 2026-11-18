import type { ReactElement } from "react";
import { PendingWork } from "./pending-work.js";
import { HomeStart } from "./home-start.js";
import type { ChatSurfaceProps } from "./chat-surface.js";
export function EmptyChatStart(props: ChatSurfaceProps): ReactElement {
  const controls = props.composer.controls;
  return (
    <div className="home-main empty-chat-home" data-screen="new-tab">
      <HomeStart
        props={{
          modelCatalog: controls
            ? { models: controls.availableModels, defaultModel: controls.effectiveModel }
            : null,
          // An empty Chat is still a Chat: keep the same model-management capability as the
          // composer's pickers, so "Add or manage models" stays reachable from a brand-new chat.
          ...(props.composer.onManageModels
            ? { onConnectModel: props.composer.onManageModels }
            : {}),
          ...(props.composer.modelLogin ? { modelLogin: props.composer.modelLogin } : {}),
          chatId: props.chatId,
          browserContext: props.composer.browserContext,
          onRemoveContext: props.composer.onRemoveBrowserContext,
          projectName: props.composer.projectName ?? null,
          projectId: props.chats.find((chat) => chat.chatId === props.chatId)?.projectId ?? null,
          onReadAttachments: async (files) => [
            ...((await props.composer.onReadDraftAttachments?.(files)) ?? []),
          ],
          onAsk: (text, model, thinking, files = []) => {
            if (props.composer.onStart) void props.composer.onStart(text, model, thinking, files);
            else void props.composer.onSend(text, "followUp", files);
          },
        }}
      />
      {(props.composer.running || props.composer.connecting) && (
        <PendingWork connecting={Boolean(props.composer.connecting)} />
      )}
    </div>
  );
}
