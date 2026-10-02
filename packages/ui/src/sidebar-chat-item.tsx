import { SidebarSectionHeading } from "./sidebar-section-heading.js";
import type { ReactElement } from "react";
import { SidebarIcon } from "./sidebar-icons.js";
import { SidebarChatMenu } from "./sidebar-chat-menu.js";
export interface SidebarChatItemProps {
  chat: { chatId: string; title: string; pinned: boolean };
  current?: boolean | undefined;
  onOpen(chatId: string): void;
  onPin?(): void;
  onDelete?(): void;
}
export function SidebarChatItem(props: SidebarChatItemProps): ReactElement {
  return (
    <div className="sidebar-chat-item" data-current={String(Boolean(props.current))}>
      <button
        className="sidebar-chat-row home-chat-row"
        type="button"
        title={props.chat.title}
        aria-current={props.current ? "page" : undefined}
        onClick={() => props.onOpen(props.chat.chatId)}
      >
        <span>{props.chat.title}</span>
      </button>
      <div className="sidebar-row-actions">
        {props.onPin && (
          <button
            type="button"
            aria-label={props.chat.pinned ? "Unpin Chat" : "Pin Chat"}
            aria-pressed={props.chat.pinned}
            onClick={props.onPin}
          >
            <SidebarIcon kind="pin" />
          </button>
        )}
        {props.onDelete && (
          <button
            type="button"
            aria-label="Delete chat"
            title="Delete chat"
            onClick={props.onDelete}
          >
            <SidebarIcon kind="delete" />
          </button>
        )}
        <SidebarChatMenu chatId={props.chat.chatId} />
      </div>
    </div>
  );
}
export function SidebarRecents({
  onNew,
  id,
}: {
  onNew(): void;
  id?: string | undefined;
}): ReactElement {
  return <SidebarSectionHeading label="Recents" id={id} onAdd={onNew} />;
}
