import { useEffect, useState, type ReactElement } from "react";

export function SidebarChatStatus({ chatId }: { chatId: string }): ReactElement | null {
  const [status, setStatus] = useState({ working: false, unread: false });
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.chatId === chatId)
        setStatus({ working: detail.working === true, unread: detail.unread === true });
    };
    window.addEventListener("aeon.chat-status", receive);
    window.dispatchEvent(new CustomEvent("aeon.chat-status-request", { detail: { chatId } }));
    return () => window.removeEventListener("aeon.chat-status", receive);
  }, [chatId]);
  if (!status.working && !status.unread) return null;
  return (
    <span
      className="sidebar-chat-status"
      role="status"
      aria-label={status.working ? "Chat is working" : "Unread completed chat"}
    >
      {status.working && (
        <svg className="sidebar-working-spinner" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="33 11"
            strokeLinecap="round"
          />
        </svg>
      )}
      {status.unread && <span className="sidebar-completion-dot" />}
    </span>
  );
}
