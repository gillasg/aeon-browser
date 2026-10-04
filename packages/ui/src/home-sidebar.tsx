import { AeonWordmark } from "./aeon-wordmark.js";
import { ProjectsSidebar } from "./projects-sidebar.js";
import type { ChatCatalogItemDto } from "@pippin/protocol";
import type { ReactElement } from "react";
import { SidebarChatItem, SidebarRecents } from "./sidebar-chat-item.js";
import { ChatNavigation } from "./chat-navigation.js";
import { SidebarManagementLinks } from "./sidebar-management-links.js";
import type { ManagementSection } from "./management-types.js";

interface HomeSections {
  pinned: readonly ChatCatalogItemDto[];
  projects: readonly ChatCatalogItemDto[];
  recent: readonly ChatCatalogItemDto[];
}

export interface HomeSidebarProps {
  developmentFixture: boolean;
  sections: HomeSections;
  collapsed: boolean;
  onCollapse(): void;
  onNewChat(): void;
  onPin(chat: ChatCatalogItemDto): void;
  onDelete(chat: ChatCatalogItemDto): void;
  onCatalog(): void;
  onOpenChat(chatId: string): void;
  management: boolean;
  managementSection: ManagementSection;
  onManagementOpen(): void;
  onManagementSection(section: ManagementSection): void;
  onReturnHome(): void;
}

export function HomeSidebar(props: HomeSidebarProps): ReactElement {
  return (
    <>
      <ChatNavigation
        sidebarOpen={!props.collapsed}
        onToggleSidebar={props.onCollapse}
        onNewChat={props.onNewChat}
        onSettings={props.onManagementOpen}
      />
      <aside id="chat-sidebar" className="home-sidebar" aria-label="Chat navigation">
        <div className="sidebar-top">
          <AeonWordmark />
        </div>

        <SidebarManagementLinks
          selected={props.management ? props.managementSection : undefined}
          onSelect={props.onManagementSection}
        />
        <NavSection
          id="pinned-label"
          listId="pinned-chats"
          title="Pinned"
          items={props.sections.pinned}
          empty="No pinned Chats"
          onOpen={props.onOpenChat}
          onPin={props.onPin}
          onDelete={props.onDelete}
        />
        <ProjectsSidebar
          chats={props.sections.projects}
          onOpen={props.onOpenChat}
          onPin={(id) => projectAction(props, id, "pin")}
          onDelete={(id) => projectAction(props, id, "delete")}
        />
        <NavSection
          id="recents-label"
          listId="recent-chats"
          title="Recents"
          items={props.sections.recent}
          empty="No Chats yet"
          onOpen={props.onOpenChat}
          onPin={props.onPin}
          onDelete={props.onDelete}
          recent
          onNew={props.onNewChat}
        />
        {props.developmentFixture && (
          <div className="home-sidebar-footer">Local fixture · no provider</div>
        )}
      </aside>
    </>
  );
}

function NavSection({
  id,
  listId,
  title,
  items,
  empty,
  onOpen,
  recent = false,
  onNew,
  onPin,
  onDelete,
}: {
  id: string;
  listId: string;
  title: string;
  items: readonly ChatCatalogItemDto[];
  empty: string;
  onOpen(chatId: string): void;
  recent?: boolean;
  onNew?: (() => void) | undefined;
  onPin(chat: ChatCatalogItemDto): void;
  onDelete(chat: ChatCatalogItemDto): void;
}): ReactElement | null {
  if (!items.length && !recent) return null;
  return (
    <section
      className={`home-nav-section${recent ? " home-recents-nav" : ""}`}
      aria-labelledby={id}
    >
      {recent && onNew ? <SidebarRecents id={id} onNew={onNew} /> : <h2 id={id}>{title}</h2>}
      <nav id={listId} aria-label={`${title} Chats`}>
        {items.map((chat) => (
          <SidebarChatItem
            key={chat.chatId}
            chat={chat}
            onOpen={onOpen}
            onPin={() => onPin(chat)}
            onDelete={() => onDelete(chat)}
          />
        ))}
      </nav>
      {!items.length && <p className="home-empty-note">{empty}</p>}
    </section>
  );
}

function projectAction(props: HomeSidebarProps, id: string, action: "pin" | "delete"): void {
  const chat = props.sections.projects.find((item) => item.chatId === id);
  if (chat) {
    if (action === "pin") props.onPin(chat);
    else props.onDelete(chat);
  }
}
