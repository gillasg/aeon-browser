import { useRef, useState, type ReactElement } from "react";
import { copyTextToClipboard } from "./clipboard.js";
import { SidebarIcon } from "./sidebar-icons.js";

export function SidebarChatMenu({ chatId }: { chatId: string }): ReactElement {
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy chat link");
  const toggle = (button: HTMLButtonElement): void => {
    const bounds = button.getBoundingClientRect();
    if (!menu.current) return;
    menu.current.style.left = `${Math.max(8, bounds.right - 180)}px`;
    menu.current.style.top = `${Math.min(bounds.bottom + 4, window.innerHeight - 90)}px`;
    menu.current.togglePopover();
  };
  return (
    <>
      <button
        type="button"
        aria-label="Chat options"
        aria-expanded={open}
        onClick={(event) => toggle(event.currentTarget)}
      >
        <SidebarIcon kind="more" />
      </button>
      <div
        ref={menu}
        popover="auto"
        className="sidebar-chat-menu"
        onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
      >
        <button type="button" onClick={() => void copyChatLink(chatId, setCopyLabel)}>
          <SidebarIcon kind="copy" />
          {copyLabel}
        </button>
      </div>
    </>
  );
}

async function copyChatLink(chatId: string, setLabel: (value: string) => void): Promise<void> {
  const link = new URL("chat.html", window.location.href);
  link.searchParams.set("chatId", chatId);
  try {
    await copyTextToClipboard(link.href);
    setLabel("Copied");
  } catch {
    setLabel("Copy failed — try again");
  }
}
