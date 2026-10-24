import type { ReactElement } from "react";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import { MiniSwarm } from "./mini-swarm.js";

// Running work as live windows: each card shows the tab its agent is acting in, refreshed about
// once a second by the engine. Recent chats sit underneath as a quiet list.

/** The latest frame of the tab a chat's agent is working in. */
export interface HomeRunPreview {
  image: string;
  title: string;
}

export function LiveRuns({
  chats,
  needs,
  previews,
  onOpenChat,
}: {
  chats: readonly ChatCatalogItemDto[];
  needs: ReadonlySet<string>;
  previews: ReadonlyMap<string, HomeRunPreview>;
  onOpenChat(chatId: string): void;
}): ReactElement | null {
  if (!chats.length) return null;
  return (
    <section className="home-block" aria-labelledby="home-running-heading">
      <div className="home-block-heading">
        <h2 id="home-running-heading">Running now</h2>
      </div>
      <div className="home-live-grid">
        {chats.map((chat) => (
          <LiveRunCard
            key={chat.chatId}
            chat={chat}
            waiting={needs.has(chat.chatId)}
            preview={previews.get(chat.chatId)}
            onOpen={() => onOpenChat(chat.chatId)}
          />
        ))}
      </div>
    </section>
  );
}

function LiveRunCard({
  chat,
  waiting,
  preview,
  onOpen,
}: {
  chat: ChatCatalogItemDto;
  waiting: boolean;
  preview: HomeRunPreview | undefined;
  onOpen(): void;
}): ReactElement {
  return (
    <button type="button" className="home-live-card" data-needs={String(waiting)} onClick={onOpen}>
      <span className="home-live-window">
        {preview ? (
          <img src={preview.image} alt={`Live view: ${preview.title}`} />
        ) : (
          <span className="home-live-idle">
            <MiniSwarm size={28} tone={waiting ? "needs" : "working"} />
          </span>
        )}
        <span className="home-live-badge">{waiting ? "Needs you" : "Live"}</span>
      </span>
      <span className="home-live-meta">
        <span className="home-live-title">{chat.title}</span>
        <span className="home-live-line">
          {waiting ? "Open to answer" : (preview?.title ?? "Working…")}
        </span>
      </span>
    </button>
  );
}

export function RecentChats({
  chats,
  openChatIds,
  onOpenChat,
  onChats,
}: {
  chats: readonly ChatCatalogItemDto[];
  openChatIds: ReadonlySet<string>;
  onOpenChat(chatId: string): void;
  onChats(): void;
}): ReactElement | null {
  if (!chats.length) return null;
  return (
    <section className="home-block home-recent" aria-labelledby="home-recent-heading">
      <div className="home-block-heading">
        <h2 id="home-recent-heading">Recent</h2>
        <button type="button" onClick={onChats}>
          All chats →
        </button>
      </div>
      <ul className="home-recent-list" id="recent-chats">
        {chats.map((chat) => (
          <li key={chat.chatId}>
            <button
              type="button"
              className="home-recent-row"
              data-open={String(openChatIds.has(chat.chatId))}
              data-pinned={String(chat.pinned)}
              title={openChatIds.has(chat.chatId) ? `${chat.title} · open in a tab` : chat.title}
              onClick={() => onOpenChat(chat.chatId)}
            >
              <span className="home-recent-title">{chat.title}</span>
              <span className="home-recent-time">
                {chat.pinned ? "Pinned" : ago(chat.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ago(at: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
