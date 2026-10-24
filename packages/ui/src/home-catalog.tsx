import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import type { NewTabHomeProps } from "./home-surface.js";
import { shortDate } from "./text.js";
import { SidebarIcon } from "./sidebar-icons.js";

type HomeCatalogProps = Pick<
  NewTabHomeProps,
  | "catalogQuery"
  | "catalogPending"
  | "catalogResults"
  | "searchWarnings"
  | "openChatIds"
  | "onCatalogQuery"
  | "onOpenChat"
  | "onPin"
  | "onDelete"
  | "onRename"
>;

export function HomeCatalog(props: HomeCatalogProps): ReactElement {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
  }, []);
  return (
    <section id="home-catalog" className="home-catalog" aria-labelledby="catalog-heading">
      <h1 id="catalog-heading">Chats</h1>
      <CatalogSearch
        refElement={search}
        query={props.catalogQuery}
        onQuery={props.onCatalogQuery}
      />
      {props.searchWarnings > 0 && (
        <p className="catalog-warning">
          Some saved Pi sessions could not be searched ({props.searchWarnings}).
        </p>
      )}
      <div className="catalog-results" aria-live="polite">
        {props.catalogPending ? (
          <p className="catalog-empty">Searching chats…</p>
        ) : props.catalogResults.length ? (
          props.catalogResults.map((chat) => (
            <CatalogRow
              key={chat.chatId}
              chat={chat}
              open={props.openChatIds.has(chat.chatId)}
              onOpen={props.onOpenChat}
              onPin={props.onPin}
              onDelete={props.onDelete}
              onRename={props.onRename}
            />
          ))
        ) : (
          <p className="catalog-empty">
            {props.catalogQuery.trim() ? "No chats match that search." : "No chats yet."}
          </p>
        )}
      </div>
      <p className="catalog-footnote">Chats remain here when their Chrome tab closes.</p>
    </section>
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
        <span aria-hidden="true">⌕</span>
        <input
          ref={refElement}
          id="catalog-query"
          type="search"
          placeholder="Search titles and messages"
          autoComplete="off"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
    </div>
  );
}

function CatalogRow({
  chat,
  open,
  onOpen,
  onPin,
  onDelete,
  onRename,
}: {
  chat: ChatCatalogItemDto;
  open: boolean;
  onOpen(chatId: string): void;
  onPin(chat: ChatCatalogItemDto): void;
  onDelete(chat: ChatCatalogItemDto): void;
  onRename(chat: ChatCatalogItemDto): void;
}) {
  return (
    <article className="catalog-result">
      <button className="catalog-result-main" type="button" onClick={() => onOpen(chat.chatId)}>
        <span className="catalog-result-title">{chat.title}</span>
        <span className="catalog-result-preview">
          {chat.matchExcerpt ?? `${chat.status} · Updated ${shortDate(chat.updatedAt)}`}
        </span>
        <span className="catalog-result-meta">
          {chat.status}
          {chat.pinned ? " · Pinned" : ""}
        </span>
      </button>
      <div className="catalog-result-actions">
        {open && <span className="result-tab-open">Open tab</span>}
        <button type="button" onClick={() => onPin(chat)}>
          {chat.pinned ? "Unpin" : "Pin"}
        </button>
        <button type="button" onClick={() => onRename(chat)}>
          Rename
        </button>
        <button
          type="button"
          className="catalog-delete"
          aria-label="Delete chat"
          title="Delete chat"
          onClick={() => onDelete(chat)}
        >
          <SidebarIcon kind="delete" />
        </button>
      </div>
    </article>
  );
}
