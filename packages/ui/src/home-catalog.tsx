import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import type { NewTabHomeProps } from "./home-surface.js";
import { SidebarIcon } from "./sidebar-icons.js";
import { ago } from "./home-live.js";

// All chats: one grouped list in the order the Ctrl+K switcher uses (needs you, running, recent).
// Each row is a dot, the title and one line of state or time; actions show on hover and focus.

type HomeCatalogProps = Pick<
  NewTabHomeProps,
  | "catalogQuery"
  | "catalogPending"
  | "catalogResults"
  | "searchWarnings"
  | "openChatIds"
  | "runningChatIds"
  | "needsChatIds"
  | "onCatalogQuery"
  | "onOpenChat"
  | "onPin"
  | "onDelete"
  | "onRename"
  | "onNewChat"
>;

type RowState = "needs" | "running" | "idle";

export function HomeCatalog(props: HomeCatalogProps): ReactElement {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
  }, []);
  const stateOf = (chat: ChatCatalogItemDto): RowState =>
    props.needsChatIds?.has(chat.chatId)
      ? "needs"
      : props.runningChatIds?.has(chat.chatId)
        ? "running"
        : "idle";
  const rank: Record<RowState, number> = { needs: 0, running: 1, idle: 2 };
  // A search keeps the daemon's relevance order; otherwise what needs you comes first.
  const rows = props.catalogQuery.trim()
    ? props.catalogResults
    : [...props.catalogResults].sort((a, b) => rank[stateOf(a)] - rank[stateOf(b)]);
  return (
    <section id="home-catalog" className="home-catalog" aria-label="Chats">
      <CatalogSearch
        refElement={search}
        query={props.catalogQuery}
        onQuery={props.onCatalogQuery}
      />
      {props.searchWarnings > 0 && (
        <p className="catalog-warning">
          {props.searchWarnings === 1
            ? "One saved chat couldn't be searched."
            : `${props.searchWarnings} saved chats couldn't be searched.`}
        </p>
      )}
      <div className="catalog-results" aria-live="polite">
        {props.catalogPending ? (
          <p className="catalog-empty">Searching…</p>
        ) : rows.length ? (
          <ul className="aeon-list catalog-list">
            {rows.map((chat) => (
              <CatalogRow
                key={chat.chatId}
                chat={chat}
                state={stateOf(chat)}
                open={props.openChatIds.has(chat.chatId)}
                onOpen={props.onOpenChat}
                onPin={props.onPin}
                onDelete={props.onDelete}
                onRename={props.onRename}
              />
            ))}
          </ul>
        ) : (
          <CatalogEmpty searching={Boolean(props.catalogQuery.trim())} onNew={props.onNewChat} />
        )}
      </div>
    </section>
  );
}

function CatalogEmpty({ searching, onNew }: { searching: boolean; onNew(): void }): ReactElement {
  if (searching) return <p className="catalog-empty">No chats match that search.</p>;
  return (
    <div className="aeon-empty">
      <p>Your chats will appear here, even after their tab closes.</p>
      <button type="button" className="aeon-button" data-tone="primary" onClick={onNew}>
        Ask Aeon something
      </button>
    </div>
  );
}

function CatalogSearch({
  refElement,
  query,
  onQuery,
}: {
  refElement: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery(value: string): void;
}): ReactElement {
  return (
    <div className="catalog-search-row">
      <label className="catalog-search-box">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          ref={refElement}
          id="catalog-query"
          type="search"
          placeholder="Search titles and messages"
          aria-label="Search chats"
          autoComplete="off"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
    </div>
  );
}

const STATE_LABEL: Record<RowState, string> = { needs: "Needs you", running: "Running", idle: "" };

function CatalogRow({
  chat,
  state,
  open,
  onOpen,
  onPin,
  onDelete,
  onRename,
}: {
  chat: ChatCatalogItemDto;
  state: RowState;
  open: boolean;
  onOpen(chatId: string): void;
  onPin(chat: ChatCatalogItemDto): void;
  onDelete(chat: ChatCatalogItemDto): void;
  onRename(chat: ChatCatalogItemDto): void;
}) {
  return (
    <li className="catalog-result" data-state={state} data-open={String(open)}>
      <button className="catalog-result-main" type="button" onClick={() => onOpen(chat.chatId)}>
        <span className="aeon-dot" data-state={state} aria-hidden="true" />
        <span className="catalog-result-text">
          <span className="catalog-result-title">{chat.title}</span>
          {chat.matchExcerpt && <span className="catalog-result-preview">{chat.matchExcerpt}</span>}
        </span>
        <span className="catalog-result-meta">
          {STATE_LABEL[state] || (chat.pinned ? "Pinned" : ago(chat.updatedAt))}
        </span>
      </button>
      <span className="catalog-result-actions">
        <RowAction
          label={chat.pinned ? "Unpin" : "Pin"}
          icon="pin"
          active={chat.pinned}
          onClick={() => onPin(chat)}
        />
        <RowAction label="Rename" icon="edit" onClick={() => onRename(chat)} />
        <RowAction label="Delete" icon="delete" onClick={() => onDelete(chat)} />
      </span>
    </li>
  );
}

function RowAction({
  label,
  icon,
  active = false,
  onClick,
}: {
  label: string;
  icon: "pin" | "edit" | "delete";
  active?: boolean;
  onClick(): void;
}): ReactElement {
  return (
    <button
      type="button"
      className={icon === "delete" ? "catalog-delete" : undefined}
      aria-label={`${label} chat`}
      title={label}
      data-active={String(active)}
      onClick={onClick}
    >
      <SidebarIcon kind={icon} />
    </button>
  );
}
