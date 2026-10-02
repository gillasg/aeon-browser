import type { ReactElement } from "react";
import { toolKind } from "./chat-activity-summary.js";

export function ActivityIcon({ toolName }: { toolName: string }): ReactElement {
  const kind = toolKind(toolName);
  const icon = semanticIcon(toolName, kind);
  return (
    <svg
      className="activity-icon"
      data-kind={kind}
      data-icon={icon}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <ActivityGlyph kind={kind} icon={icon} toolName={toolName} />
    </svg>
  );
}

function ActivityGlyph({
  kind,
  icon,
  toolName,
}: {
  kind: ReturnType<typeof toolKind>;
  icon: ReturnType<typeof semanticIcon>;
  toolName: string;
}): ReactElement {
  const nav = navGlyph(icon);
  if (nav) return nav;
  if (kind === "file" && icon === "file") return fileGlyph(toolName);
  if (kind === "browser" && icon === "browser") {
    return (
      <>
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
        <path d="M3 7h14M6 5.3h.1M8.5 5.3h.1" />
      </>
    );
  }
  if (kind === "shell" && icon === "shell") return <path d="m3.5 5.5 4.5 4.5-4.5 4.5m7 0h5" />;
  if (kind === "code" && icon === "code") {
    return <path d="m5.5 5-4 5 4 5m9-10 4 5-4 5m-3-12-3 14" />;
  }
  return (
    <>
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
      <path d="M8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3" />
    </>
  );
}

function navGlyph(icon: ReturnType<typeof semanticIcon>): ReactElement | null {
  if (icon === "search") {
    return (
      <>
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" />
      </>
    );
  }
  if (icon === "history") {
    return (
      <>
        <path d="M3 8a7 7 0 1 1 1 6" />
        <path d="M3 3v5h5m2-1v4l3 2" />
      </>
    );
  }
  if (icon === "memory") {
    return (
      <>
        <rect x="5" y="5" width="10" height="10" rx="2" />
        <path d="M8 9h4m-4 3h4M7 2v3m6-3v3M7 15v3m6-3v3M2 7h3m-3 6h3m10-6h3m-3 6h3" />
      </>
    );
  }
  if (icon === "routine") return <path d="m11 2-7 9h5l-1 7 8-10h-5z" />;
  return null;
}

function fileGlyph(toolName: string): ReactElement {
  if (/read|openfile/i.test(toolName)) {
    return (
      <>
        <path d="M5 2.5h7l4 4V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" />
        <path d="M12 2.5V7h4M7 11h6m-6 3h6" />
      </>
    );
  }
  if (/edit|patch/i.test(toolName)) {
    return (
      <>
        <path d="M8 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3" />
        <path d="m14 2 4 4-9 9H5v-4z" />
      </>
    );
  }
  return (
    <>
      <rect x="2" y="3" width="16" height="14" rx="3" fill="currentColor" stroke="none" />
      <path d="M5 12V8l2 2 2-2v4m3-3v4m-2-2h4" stroke="var(--canvas)" />
    </>
  );
}

function semanticIcon(
  toolName: string,
  kind: ReturnType<typeof toolKind>,
): "browser" | "file" | "shell" | "code" | "search" | "history" | "memory" | "routine" | "other" {
  const name = toolName.toLowerCase();
  if (/search|find/.test(name)) return "search";
  if (/history/.test(name)) return "history";
  if (/memory/.test(name)) return "memory";
  if (/routine/.test(name)) return "routine";
  return kind;
}

export function DisclosureChevron(): ReactElement {
  return (
    <svg className="activity-chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m4 2 4 4-4 4" />
    </svg>
  );
}
