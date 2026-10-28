import type { ReactElement } from "react";
export function SidebarIcon({
  kind,
}: {
  kind:
    | "settings"
    | "routines"
    | "automations"
    | "sites"
    | "sessions"
    | "resources"
    | "capabilities"
    | "pin"
    | "delete"
    | "plus"
    | "more"
    | "copy"
    | "edit"
    | "open";
}): ReactElement {
  const paths = {
    settings:
      "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6m-2.3-6-.5 2.1-1.5.9-2.1-.6-2.3 4 1.6 1.5v1.9l-1.6 1.5 2.3 4 2.1-.6 1.5.9.5 2.1h4.6l.5-2.1 1.5-.9 2.1.6 2.3-4-1.6-1.5v-1.9l1.6-1.5-2.3-4-2.1.6-1.5-.9-.5-2.1Z",
    routines: "M12 4a8 8 0 1 1-6 3M4 3v5h5M12 8v4l3 2",
    automations: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m-2 5 6 4-6 4z",
    sites:
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18",
    sessions: "M14 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 8h5M19.5 5.5v5",
    resources: "m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
    capabilities: "m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16",
    pin: "M16 9V3H8v6l-3 3v3h14v-3l-3-3M12 15v6",
    delete: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
    plus: "M12 5v14M5 12h14",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    copy: "M8 8h12v12H8zM16 8V4H4v12h4",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={kind === "more" ? "3" : "1.4"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
