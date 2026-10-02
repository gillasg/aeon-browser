import { useRef, type ReactElement } from "react";
import { SidebarIcon } from "./sidebar-icons.js";
export function ProjectRowActions({
  name,
  onNew,
  onEdit,
}: {
  name: string;
  onNew(): void;
  onEdit(): void;
}): ReactElement {
  const menu = useRef<HTMLDivElement>(null);
  return (
    <div className="project-row-actions">
      <button
        type="button"
        aria-label={"Project options for " + name}
        onClick={(event) => {
          if (!menu.current) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          menu.current.style.left = Math.max(8, bounds.right - 180) + "px";
          menu.current.style.top = Math.min(bounds.bottom + 4, innerHeight - 55) + "px";
          menu.current.togglePopover();
        }}
      >
        <SidebarIcon kind="more" />
      </button>
      <button type="button" aria-label={"New chat in " + name} onClick={onNew}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6M16 3l5 5M9 15l1-5 8-8 4 4-8 8-5 1Z" />
        </svg>
      </button>
      <div ref={menu} popover="auto" className="sidebar-chat-menu">
        <button
          type="button"
          onClick={() => {
            menu.current?.hidePopover();
            onEdit();
          }}
        >
          Edit project
        </button>
      </div>
    </div>
  );
}
