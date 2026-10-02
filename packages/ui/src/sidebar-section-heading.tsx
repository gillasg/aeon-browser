import { useState, type ReactElement } from "react";
import { SidebarIcon } from "./sidebar-icons.js";
export function SidebarSectionHeading({
  label,
  onAdd,
  id,
}: {
  label: string;
  onAdd(): void;
  id?: string | undefined;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="sidebar-recents-heading" data-collapsed={String(collapsed)}>
      <button
        className="sidebar-section-toggle"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span id={id}>{label}</span>
        <svg
          className="sidebar-section-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d={collapsed ? "m6 3 5 5-5 5" : "m3 6 5 5 5-5"} />
        </svg>
      </button>
      <button
        type="button"
        aria-label={label === "Projects" ? "Create project" : "New Chat"}
        onClick={onAdd}
      >
        <SidebarIcon kind="plus" />
      </button>
    </div>
  );
}
