import { ProjectsSidebar } from "./projects-sidebar.js";
import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { SidebarChatItem, SidebarRecents } from "./sidebar-chat-item.js";
import { SidebarManagementLinks } from "./sidebar-management-links.js";
import type { ManagementSection } from "./management-types.js";
import type { ChatSummaryDto } from "@pippin/protocol";

export interface ChatSidebarProps {
  developmentFixture: boolean;
  chats: readonly ChatSummaryDto[];
  currentChatId: string;
  query: string;
  open: boolean;
  onQuery(value: string): void;
  onOpen(chatId: string): void;
  onClose(): void;
  onNew(): void;
  onPin?(chat: ChatSummaryDto): void;
  onDelete?(chat: ChatSummaryDto): void;
  onManagement?(section: ManagementSection): void;
  managementSection?: ManagementSection | undefined;
}

export function ChatSidebar(props: ChatSidebarProps): ReactElement {
  const matches = props.chats;
  const modal = matchMedia("(max-width: 720px)").matches;
  const aside = useRef<HTMLElement>(null);
  useSidebarFocus(props.open, props.onClose, aside);
  return (
    <>
      <SidebarDialog {...props} modal={modal} matches={matches} aside={aside} />
      <SidebarScrim open={props.open && modal} onClose={props.onClose} />
    </>
  );
}

function useSidebarFocus(
  open: boolean,
  onClose: () => void,
  aside: RefObject<HTMLElement | null>,
): void {
  const wasOpen = useRef(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const modal = matchMedia("(max-width: 720px)").matches;
    if (open && modal) aside.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (wasOpen.current) document.getElementById("sidebar-toggle")?.focus();
    wasOpen.current = open;
    if (!open) return;
    const onKey = (event: KeyboardEvent) =>
      handleSidebarKey(event, modal, aside.current, close.current);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}

function SidebarDialog(
  props: ChatSidebarProps & {
    modal: boolean;
    matches: readonly ChatSummaryDto[];
    aside: RefObject<HTMLElement | null>;
  },
): ReactElement {
  return (
    <aside
      id="chat-sidebar"
      ref={props.aside}
      className="chat-sidebar"
      role="dialog"
      aria-modal={props.open && props.modal}
      hidden={!props.open}
      aria-label="Aeon Chats"
    >
      <div className="sidebar-top" />
      {props.onManagement && (
        <SidebarManagementLinks onSelect={props.onManagement} selected={props.managementSection} />
      )}
      {props.matches.some((chat) => chat.pinned) && (
        <>
          <div className="sidebar-recents-heading">
            <span>Pinned</span>
          </div>
          <SidebarRows
            matches={props.matches.filter((chat) => chat.pinned)}
            currentChatId={props.currentChatId}
            onOpen={props.onOpen}
            onPin={props.onPin}
            onDelete={props.onDelete}
          />
        </>
      )}
      <ProjectsSidebar
        chats={props.matches}
        currentChatId={props.currentChatId}
        onOpen={props.onOpen}
        onPin={(id) => projectAction(props, id, "pin")}
        onDelete={(id) => projectAction(props, id, "delete")}
      />
      <SidebarRecents onNew={props.onNew} />
      <SidebarRows
        matches={props.matches.filter((chat) => !chat.pinned && !chat.projectId)}
        currentChatId={props.currentChatId}
        onOpen={props.onOpen}
        onPin={props.onPin}
        onDelete={props.onDelete}
      />
      {props.developmentFixture && (
        <div className="sidebar-footer">Local fixture · no provider</div>
      )}
    </aside>
  );
}

function SidebarRows({
  matches,
  currentChatId,
  onOpen,
  onPin,
  onDelete,
}: {
  matches: readonly ChatSummaryDto[];
  currentChatId: string;
  onOpen(chatId: string): void;
  onPin?: ((chat: ChatSummaryDto) => void) | undefined;
  onDelete?: ((chat: ChatSummaryDto) => void) | undefined;
}): ReactElement {
  const empty = "No Chats yet";
  return (
    <nav className="sidebar-chat-list" aria-label="Recent Chats">
      {matches.length ? (
        matches.map((chat) => (
          <SidebarChatItem
            key={chat.chatId}
            chat={chat}
            current={chat.chatId === currentChatId}
            onOpen={onOpen}
            {...(onPin ? { onPin: () => onPin(chat) } : {})}
            {...(onDelete ? { onDelete: () => onDelete(chat) } : {})}
          />
        ))
      ) : (
        <div className="sidebar-empty">{empty}</div>
      )}
    </nav>
  );
}

function SidebarScrim({ open, onClose }: { open: boolean; onClose(): void }): ReactElement {
  return (
    <button
      id="sidebar-scrim"
      className="sidebar-scrim"
      type="button"
      aria-label="Close Chat list"
      hidden={!open}
      onClick={onClose}
    />
  );
}

function handleSidebarKey(
  event: KeyboardEvent,
  modal: boolean,
  aside: HTMLElement | null,
  close: () => void,
): void {
  if (event.key === "Escape") {
    close();
    return;
  }
  if (modal && event.key === "Tab") cycleSidebarFocus(event, aside);
}

function cycleSidebarFocus(event: KeyboardEvent, aside: HTMLElement | null): void {
  const focusable = [
    ...(aside?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ) ?? []),
  ];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function projectAction(props: ChatSidebarProps, id: string, action: "pin" | "delete"): void {
  const chat = props.chats.find((item) => item.chatId === id);
  if (chat) {
    if (action === "pin") props.onPin?.(chat);
    else props.onDelete?.(chat);
  }
}
