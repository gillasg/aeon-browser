import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { ChatCatalogItemDto } from "@graft/protocol";
import { PickerChevron } from "./picker-chevron.js";
import { SidebarIcon } from "./sidebar-icons.js";

export interface SidePanelProps {
  chats: readonly Pick<ChatCatalogItemDto, "chatId" | "title" | "updatedAt">[];
  selectedChatId: string;
  status: string;
  pickerOpen: boolean;
  chatFrameSrc: string;
  onTogglePicker(open: boolean): void;
  onSelect(chatId: string): void;
  onNew(): void;
  /** Opens (or focuses) the Manage tab: sites, skills, watches, settings. */
  onManage(): void;
}

/**
 * The switcher's name: `Graft` on a clean install, `New chat` with history but nothing chosen, and
 * the chat's title only once it has one of its own (never a phantom title on an idle panel).
 */
export function switcherLabel(
  chats: SidePanelProps["chats"],
  selected: SidePanelProps["chats"][number] | undefined,
): string {
  const title = selected?.title.trim();
  if (title && !/^new chat$/i.test(title)) return title;
  return chats.length ? "New chat" : "Graft";
}

export function SidePanel(props: SidePanelProps): ReactElement {
  const selected = props.chats.find((chat) => chat.chatId === props.selectedChatId);
  const header = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  usePickerBehavior(props.pickerOpen, props.onTogglePicker, header, trigger);
  return (
    <>
      <PanelHeader
        props={props}
        label={switcherLabel(props.chats, selected)}
        header={header}
        trigger={trigger}
      />
      <p id="panel-status" role="status" aria-live="polite">
        {props.status}
      </p>
      {props.chatFrameSrc ? (
        <ChatFrame chatId={selected?.chatId ?? "new-chat"} src={props.chatFrameSrc} />
      ) : (
        <PanelEmpty />
      )}
    </>
  );
}

function usePickerBehavior(
  open: boolean,
  onToggle: (open: boolean) => void,
  header: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !header.current?.contains(event.target)) onToggle(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onToggle(false);
        trigger.current?.focus();
      }
    };
    const onBlur = () => onToggle(false);
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
}

function PanelHeader({
  props,
  label,
  header,
  trigger,
}: {
  props: SidePanelProps;
  label: string;
  header: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  return (
    <header className="panel-header" ref={header}>
      <div className="picker-wrap">
        <button
          ref={trigger}
          id="chat-picker-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={props.pickerOpen}
          aria-controls="chat-picker-menu"
          onClick={() => props.onTogglePicker(!props.pickerOpen)}
        >
          <span id="selected-chat-title">{label}</span>
          <PickerChevron />
        </button>
        {props.pickerOpen && <PickerMenu props={props} />}
      </div>
      <button
        id="panel-new-chat"
        className="panel-icon-button"
        type="button"
        aria-label="New chat"
        title="New chat"
        onClick={props.onNew}
      >
        <SidebarIcon kind="plus" />
      </button>
    </header>
  );
}

function PickerMenu({ props }: { props: SidePanelProps }): ReactElement {
  return (
    <div id="chat-picker-menu" className="picker-menu" role="dialog" aria-label="Choose a Chat">
      <PickerOptions
        chats={props.chats}
        selectedId={props.selectedChatId}
        onSelect={props.onSelect}
      />
      <hr className="picker-divider" />
      <button id="picker-manage" className="picker-manage" type="button" onClick={props.onManage}>
        Manage Graft <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

function PickerOptions({
  chats,
  selectedId,
  onSelect,
}: {
  chats: SidePanelProps["chats"];
  selectedId: string;
  onSelect(chatId: string): void;
}): ReactElement {
  const groups = groupChatsByRecency(chats);
  return (
    <div id="chat-picker-list" className="picker-chat-list" role="listbox" aria-label="Chats">
      {groups.length ? (
        groups.map(({ label, chats: items }) => (
          <section key={label} className="picker-chat-group" role="group" aria-label={label}>
            <h3>{label}</h3>
            {items.map((chat) => (
              <button
                key={chat.chatId}
                className="picker-chat-row"
                type="button"
                role="option"
                data-chat-id={chat.chatId}
                aria-selected={chat.chatId === selectedId}
                onClick={() => onSelect(chat.chatId)}
              >
                <span>{chat.title}</span>
                <span className="picker-check" aria-hidden="true">
                  {chat.chatId === selectedId ? "✓" : ""}
                </span>
              </button>
            ))}
          </section>
        ))
      ) : (
        <p className="picker-empty">No chats yet</p>
      )}
    </div>
  );
}

function groupChatsByRecency(
  chats: SidePanelProps["chats"],
  now = new Date(),
): Array<{ label: string; chats: SidePanelProps["chats"] }> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const recentCutoff = today - 6 * 24 * 60 * 60 * 1000;
  const groups = new Map<string, Array<SidePanelProps["chats"][number]>>();
  const labels = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;
  for (const chat of chats) {
    const timestamp = Date.parse(chat.updatedAt);
    const day = Number.isNaN(timestamp)
      ? Number.NEGATIVE_INFINITY
      : new Date(timestamp).setHours(0, 0, 0, 0);
    const label =
      day >= today
        ? labels[0]
        : day >= yesterday
          ? labels[1]
          : day >= recentCutoff
            ? labels[2]
            : labels[3];
    const group = groups.get(label) ?? [];
    group.push(chat);
    groups.set(label, group);
  }
  return labels.flatMap((label) => {
    const items = groups.get(label);
    return items?.length ? [{ label, chats: items }] : [];
  });
}

function ChatFrame({ chatId, src }: { chatId: string; src: string }): ReactElement {
  return <iframe key={chatId} id="chat-frame" title="Selected Graft Chat" src={src} />;
}

function PanelEmpty(): ReactElement {
  return (
    <section id="panel-empty" className="panel-empty">
      <div className="empty-mark" aria-hidden="true">
        a
      </div>
      <h1>Choose a Chat</h1>
      <p>Select a Chat above or start a new one. This Chat stays selected while you switch tabs.</p>
    </section>
  );
}
