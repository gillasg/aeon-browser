import { useState, type ReactElement } from "react";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import { LatticeMark } from "./lattice-mark.js";
import { SidebarIcon } from "./sidebar-icons.js";

// Running work as live windows: each card shows the tab its agent is acting in, refreshed about
// once a second by the engine. Recent chats sit underneath as a quiet list that folds away.

/** The latest frame of the tab a chat's agent is working in. */
export interface HomeRunPreview {
  image: string;
  title: string;
}

/** What a running card can do besides open its chat. */
export interface HomeRunActions {
  /** Chats whose agent works in a window of its own. */
  windows: ReadonlySet<string>;
  onShowWindow(chatId: string): void;
  onStop(chatId: string): void;
}

export function LiveRuns({
  chats,
  needs,
  previews,
  actions,
  onOpenChat,
}: {
  chats: readonly ChatCatalogItemDto[];
  needs: ReadonlySet<string>;
  previews: ReadonlyMap<string, HomeRunPreview>;
  actions?: HomeRunActions | undefined;
  onOpenChat(chatId: string): void;
}): ReactElement | null {
  if (!chats.length) return null;
  return (
    <section className="home-block" aria-labelledby="home-running-heading">
      <h2 id="home-running-heading" className="home-live-caption">
        <RunningCaption
          total={chats.length}
          waiting={chats.filter((chat) => needs.has(chat.chatId)).length}
        />
      </h2>
      <div className="home-live-grid">
        {chats.map((chat) => (
          <LiveRunCard
            key={chat.chatId}
            chat={chat}
            waiting={needs.has(chat.chatId)}
            preview={previews.get(chat.chatId)}
            actions={actions}
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
  actions,
  onOpen,
}: {
  chat: ChatCatalogItemDto;
  waiting: boolean;
  preview: HomeRunPreview | undefined;
  actions: HomeRunActions | undefined;
  onOpen(): void;
}): ReactElement {
  return (
    <div className="home-live-item">
      <LiveRunButton chat={chat} waiting={waiting} preview={preview} onOpen={onOpen} />
      {actions && (
        <span className="home-live-actions">
          {actions.windows.has(chat.chatId) && (
            <button type="button" onClick={() => actions.onShowWindow(chat.chatId)}>
              Show window
            </button>
          )}
          <button type="button" onClick={() => actions.onStop(chat.chatId)}>
            Stop
          </button>
        </span>
      )}
    </div>
  );
}

function LiveRunButton({
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
            <LatticeMark size={32} turning />
          </span>
        )}
        <span className="home-live-badge" aria-label={waiting ? "Needs you" : "Working"}>
          {waiting ? "Needs you" : ""}
        </span>
      </span>
      <span className="home-live-meta">
        <span className="home-live-title">
          <span className="home-live-dot" aria-hidden="true" />
          {chat.title}
        </span>
        <span className="home-live-line">
          {waiting ? "Needs you · open to answer" : (preview?.title ?? "Working…")}
        </span>
      </span>
    </button>
  );
}

function RunningCaption({ total, waiting }: { total: number; waiting: number }): ReactElement {
  return (
    <>
      Running · {total}
      {waiting > 0 && <b> · {waiting} needs you</b>}
    </>
  );
}

const RECENT_OPEN_KEY = "aeon.home.recent-open";

/** Whether Recent is unfolded, remembered on this device. */
function useRecentOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(RECENT_OPEN_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const toggle = (): void =>
    setOpen((current) => {
      try {
        localStorage.setItem(RECENT_OPEN_KEY, String(!current));
      } catch {
        // Not remembered; still toggles for this visit.
      }
      return !current;
    });
  return [open, toggle];
}

type ChatAction = ((chat: ChatCatalogItemDto) => void) | undefined;

export function RecentChats({
  chats,
  openChatIds,
  onOpenChat,
  onChats,
  onPin,
  onDelete,
}: {
  chats: readonly ChatCatalogItemDto[];
  openChatIds: ReadonlySet<string>;
  onOpenChat(chatId: string): void;
  onChats(): void;
  onPin?: ChatAction;
  onDelete?: ChatAction;
}): ReactElement | null {
  const [open, toggle] = useRecentOpen();
  if (!chats.length) return null;
  return (
    <section
      className="home-block home-recent"
      data-open={String(open)}
      aria-labelledby="home-recent-heading"
    >
      <div className="home-block-heading">
        <h2 id="home-recent-heading">
          <button
            type="button"
            className="home-recent-toggle"
            aria-expanded={open}
            aria-controls="recent-chats"
            onClick={toggle}
          >
            <span className="home-recent-chevron" aria-hidden="true" />
            Recent
          </button>
        </h2>
        <button type="button" onClick={onChats}>
          All chats →
        </button>
      </div>
      <ul className="aeon-list home-recent-list" id="recent-chats" hidden={!open}>
        {chats.map((chat) => (
          <RecentRow
            key={chat.chatId}
            chat={chat}
            open={openChatIds.has(chat.chatId)}
            onOpen={() => onOpenChat(chat.chatId)}
            onPin={onPin}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </section>
  );
}

function RecentRow({
  chat,
  open,
  onOpen,
  onPin,
  onDelete,
}: {
  chat: ChatCatalogItemDto;
  open: boolean;
  onOpen(): void;
  onPin: ChatAction;
  onDelete: ChatAction;
}): ReactElement {
  return (
    <li className="home-recent-item" data-open={String(open)} data-pinned={String(chat.pinned)}>
      <button
        type="button"
        className="home-recent-row"
        title={open ? `${chat.title} · open in a tab` : chat.title}
        onClick={onOpen}
      >
        <span className="home-recent-title">{chat.title}</span>
        <span className="home-recent-time" aria-label={chat.pinned ? "Pinned" : undefined}>
          {chat.pinned ? <SidebarIcon kind="pin" /> : ago(chat.updatedAt)}
        </span>
      </button>
      <span className="home-recent-actions">
        {onPin && (
          <button
            type="button"
            aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
            title={chat.pinned ? "Unpin" : "Pin"}
            data-active={String(chat.pinned)}
            onClick={() => onPin(chat)}
          >
            <SidebarIcon kind="pin" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            aria-label="Delete chat"
            title="Delete chat"
            onClick={() => onDelete(chat)}
          >
            <SidebarIcon kind="delete" />
          </button>
        )}
      </span>
    </li>
  );
}

export function ago(at: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
