import type { ReactElement } from "react";
import { SidebarIcon } from "./sidebar-icons.js";
import type { ManagementSection } from "./management-types.js";
export function SidebarManagementLinks({
  onSelect,
  selected,
}: {
  onSelect(section: ManagementSection): void;
  selected?: ManagementSection | undefined;
}): ReactElement {
  return (
    <nav className="sidebar-management-links" aria-label="Workspace">
      {(
        [
          ["automations", "Automations"],
          ["sites", "Sites"],
          ["settings", "Settings"],
        ] as const
      ).map(([section, label]) => (
        <button
          type="button"
          key={section}
          aria-current={selected === section ? "page" : undefined}
          onClick={() => onSelect(section)}
        >
          <SidebarIcon kind={section} />
          {label}
        </button>
      ))}
    </nav>
  );
}
