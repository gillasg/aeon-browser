import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type { ChatSummaryDto } from "@aeon/protocol";

// A pill that opens a searchable list of chats: those waiting for the user first, then working
// ones (with their dot), then the most recent. Used beside Home and New chat on a chat page, and
// in the orb. Ctrl+K opens it.

type SwitcherChat = Pick<ChatSummaryDto, "chatId" | "title" | "updatedAt">;

export interface ChatSwitcherProps {
  chats: readonly SwitcherChat[];
  currentChatId?: string | undefined;
  running?: ReadonlySet<string> | undefined;
  needs?: ReadonlySet<string> | undefined;
  onSelect(chatId: string): void;
  /** Called when the list opens, so the host can refresh it. */
  onOpen?: (() => void) | undefined;
  /** Open with Ctrl+K (Cmd+K on macOS) from anywhere on the page. */
  shortcut?: boolean;
  label?: string;
  /** A round icon button (the chat page's corner) instead of a text pill (the orb). */
  icon?: boolean;
}

export function ChatSwitcher(props: ChatSwitcherProps): ReactElement {
  const [open, setOpen] = useState(false);
  const show = (next: boolean): void => {
    setOpen(next);
    if (next) props.onOpen?.();
  };
  useShortcut(props.shortcut === true, () => show(!open));
  return (
    <div className="chat-switcher" data-open={String(open)}>
      <SwitcherButton
        icon={props.icon === true}
        label={props.label}
        open={open}
        onClick={() => show(!open)}
      />
      {open && (
        <SwitcherMenu
          {...props}
          onClose={() => show(false)}
          onChoose={(chatId) => {
            show(false);
            if (chatId !== props.currentChatId) props.onSelect(chatId);
          }}
        />
      )}
    </div>
  );
}

function useShortcut(enabled: boolean, toggle: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
}

function SwitcherButton(props: {
  icon: boolean;
  label: string | undefined;
  open: boolean;
  onClick(): void;
}): ReactElement {
  return (
    <button
      type="button"
      className={props.icon ? "icon-button chat-switcher-pill" : "chat-switcher-pill"}
      aria-haspopup="listbox"
      aria-expanded={props.open}
      aria-label="Switch chat"
      title="Switch chat (Ctrl+K)"
      onClick={props.onClick}
    >
      {props.icon ? (
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6.5 6h9M6.5 10h9M6.5 14h9" />
          <path d="M3.8 6h.01M3.8 10h.01M3.8 14h.01" strokeWidth="2" />
        </svg>
      ) : (
        <>
          <span className="chat-switcher-label">{props.label ?? "Chats"}</span>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path
              d="M3 4.5 6 7.5l3-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </>
      )}
    </button>
  );
}

function SwitcherMenu(
  props: ChatSwitcherProps & { onClose(): void; onChoose(chatId: string): void },
): ReactElement {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => ordered(props, query), [props, query]);
  useEffect(() => input.current?.focus(), []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "ArrowDown")
      setActive((index) => Math.min(index + 1, list.length - 1));
    else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
    else if (event.key === "Enter" && list[active]) props.onChoose(list[active].chatId);
    else return;
    event.preventDefault();
  };
  return (
    <div className="chat-switcher-menu" onBlur={(event) => blurAway(event, props.onClose)}>
      <input
        ref={input}
        type="search"
        placeholder="Find a chat"
        aria-label="Find a chat"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul role="listbox" aria-label="Chats">
        {list.map((chat, index) => (
          <li
            key={chat.chatId}
            role="option"
            aria-selected={index === active}
            data-current={String(chat.chatId === props.currentChatId)}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onChoose(chat.chatId)}
          >
            <i data-state={stateOf(props, chat.chatId)} aria-hidden="true" />
            <span>{chat.title}</span>
            <small>{ago(chat.updatedAt)}</small>
          </li>
        ))}
        {!list.length && <li className="chat-switcher-empty">No chats match</li>}
      </ul>
    </div>
  );
}

function stateOf(props: ChatSwitcherProps, chatId: string): string {
  if (props.needs?.has(chatId)) return "needs";
  return props.running?.has(chatId) ? "running" : "idle";
}

function ordered(props: ChatSwitcherProps, query: string): readonly SwitcherChat[] {
  const text = query.trim().toLowerCase();
  const rank = (chatId: string): number =>
    props.needs?.has(chatId) ? 0 : props.running?.has(chatId) ? 1 : 2;
  return props.chats
    .filter((chat) => !text || chat.title.toLowerCase().includes(text))
    .slice()
    .sort((a, b) => rank(a.chatId) - rank(b.chatId) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 40);
}

function blurAway(event: FocusEvent<HTMLElement>, close: () => void): void {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  if (minutes < 60 * 24) return Math.round(minutes / 60) + "h";
  return Math.round(minutes / (60 * 24)) + "d";
}
