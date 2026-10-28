import { SidebarIcon } from "./sidebar-icons.js";
import type { ReactElement } from "react";
import { ChatSwitcher, type ChatSwitcherProps } from "./chat-switcher.js";

// The corner of a chat page: back home, a new chat, and the chat switcher (Ctrl+K) to jump
// between chats without going home.
export function ChatNavigation(props: {
  onNewChat?(): void;
  switcher?: ChatSwitcherProps | undefined;
}): ReactElement {
  return (
    <nav className="chat-navigation" aria-label="Chat navigation">
      <button
        id="chat-home"
        className="icon-button"
        type="button"
        aria-label="Home"
        title="Home"
        onClick={goHome}
      >
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 9.5 10 4l6.5 5.5" />
          <path d="M5.5 8.5V16h9V8.5" />
        </svg>
      </button>
      {props.onNewChat && <NewChatButton onClick={props.onNewChat} />}
      {props.switcher && <ChatSwitcher {...props.switcher} />}
    </nav>
  );
}

/** Home in the same host: the side panel stays a side panel. */
function goHome(): void {
  const panel = document.body.dataset.host === "panel";
  location.href = panel ? "home.html?host=panel" : "home.html";
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
