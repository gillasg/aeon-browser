import { useState, type ReactElement } from "react";
import type { ChatCatalogItemDto, HomeRoutineCardDto } from "@aeon/protocol";
export function HomeRecentCards({
  chats,
  routines,
  openChatIds,
  onOpen,
  onRoutines,
  onCatalog,
}: {
  chats: readonly ChatCatalogItemDto[];
  routines: readonly HomeRoutineCardDto[];
  openChatIds: ReadonlySet<string>;
  onOpen(id: string): void;
  onRoutines(): void;
  onCatalog(): void;
}): ReactElement {
  const [collection, setCollection] = useState<"chats" | "routines">("chats");
  const [collapsed, setCollapsed] = useState(true);
  return (
    <section className="home-recent-section" aria-label="Recent chats and routines">
      <div className="home-section-heading">
        <div className="home-collection-tabs" role="tablist" aria-label="Home collection">
          {(["chats", "routines"] as const).map((value) => (
            <button
              key={value}
              type="button"
              id={`home-${value}-tab`}
              role="tab"
              aria-selected={collection === value}
              aria-controls="home-collection-panel"
              onClick={() => setCollection(value)}
            >
              {value === "chats" ? "Chats" : "Routines"}
            </button>
          ))}
        </div>
        <CollectionActions
          collection={collection}
          collapsed={collapsed}
          onAll={collection === "chats" ? onCatalog : onRoutines}
          onToggle={() => setCollapsed(!collapsed)}
        />
      </div>
      <div
        id="home-collection-panel"
        role="tabpanel"
        hidden={collapsed}
        aria-labelledby={`home-${collection}-tab`}
      >
        {collection === "chats" ? (
          <RecentChats chats={chats} openChatIds={openChatIds} onOpen={onOpen} />
        ) : (
          <RoutineCards routines={routines} onOpen={onOpen} />
        )}
      </div>
    </section>
  );
}
function CollectionActions({
  collection,
  collapsed,
  onAll,
  onToggle,
}: {
  collection: "chats" | "routines";
  collapsed: boolean;
  onAll(): void;
  onToggle(): void;
}): ReactElement {
  return (
    <div className="home-collection-actions">
      <button type="button" onClick={onAll}>
        {collection === "chats" ? "All Chats" : "All Routines"} <span aria-hidden="true">›</span>
      </button>
      <button
        type="button"
        aria-label={collapsed ? "Expand chats and routines" : "Minimize chats and routines"}
        aria-expanded={!collapsed}
        aria-controls="home-collection-panel"
        onClick={onToggle}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d={collapsed ? "m4 6 4 4 4-4" : "m4 10 4-4 4 4"} />
        </svg>
      </button>
    </div>
  );
}
function RecentChats({
  chats,
  openChatIds,
  onOpen,
}: {
  chats: readonly ChatCatalogItemDto[];
  openChatIds: ReadonlySet<string>;
  onOpen(id: string): void;
}): ReactElement {
  const recent = chats.slice(0, 3);
  if (!recent.length)
    return <p className="home-cards-empty">Your recent Chats will appear here.</p>;
  return (
    <div className="home-cards">
      {recent.map((chat) => (
        <button
          type="button"
          key={chat.chatId}
          className="home-chat-card"
          data-open={String(openChatIds.has(chat.chatId))}
          onClick={() => onOpen(chat.chatId)}
        >
          <span className="card-date">{relativeDate(chat.updatedAt)}</span>
          <span className="card-title">{chat.title}</span>
          {chat.matchExcerpt && <span className="card-preview">{chat.matchExcerpt}</span>}
        </button>
      ))}
      {Array.from({ length: 3 - recent.length }, (_, index) => (
        <div key={index} className="home-card-placeholder" aria-hidden="true" />
      ))}
    </div>
  );
}
function RoutineCards({
  routines,
  onOpen,
}: {
  routines: readonly HomeRoutineCardDto[];
  onOpen(id: string): void;
}): ReactElement {
  if (!routines.length) return <p className="home-cards-empty">Your routines will appear here.</p>;
  return (
    <div className="home-cards">
      {routines.map((routine) => (
        <button
          type="button"
          key={routine.routineId}
          className="home-chat-card"
          onClick={() => onOpen(routine.chatId)}
        >
          <span className="card-date">
            {!routine.enabled
              ? "Paused"
              : routine.nextDueAt
                ? `Next: ${new Date(routine.nextDueAt).toLocaleString()}`
                : "Scheduled"}
          </span>
          <span className="card-title">{routine.title}</span>
          <span className="card-preview">{routine.chatTitle}</span>
        </button>
      ))}
    </div>
  );
}
function relativeDate(value: string): string {
  const now = new Date();
  const date = new Date(value);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86400000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-days, "day");
}
