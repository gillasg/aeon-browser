import { SidebarIcon } from "./sidebar-icons.js";
import type { ReactElement } from "react";
import type { ChatSurfaceProps } from "./chat-surface.js";
export function ChatNavigation(
  props: Pick<ChatSurfaceProps, "sidebarOpen" | "onToggleSidebar"> & {
    onSettings(): void;
    onNewChat?(): void;
  },
): ReactElement {
  return (
    <nav className="chat-navigation" aria-label="Chat navigation">
      <button
        id="sidebar-toggle"
        className="icon-button"
        type="button"
        aria-label={props.sidebarOpen ? "Close Chat list" : "Open Chat list"}
        aria-expanded={props.sidebarOpen}
        aria-controls="chat-sidebar"
        onClick={props.onToggleSidebar}
      >
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M8 4v12" />
        </svg>
      </button>
      {!props.sidebarOpen && props.onNewChat && <NewChatButton onClick={props.onNewChat} />}
    </nav>
  );
}

function NewChatButton({ onClick }: { onClick(): void }): ReactElement {
  return (
    <button
      id="collapsed-new-chat"
      className="icon-button"
      type="button"
      aria-label="New Chat"
      title="New Chat"
      onClick={onClick}
    >
      <SidebarIcon kind="plus" />
    </button>
  );
}
