import type { ReactElement } from "react";
type Mode = "preview" | "source" | "diff";
export function ViewerControls({
  mode,
  onMode,
  markdown,
  hasDiff,
}: {
  mode: Mode;
  onMode(mode: Mode): void;
  markdown: boolean;
  hasDiff: boolean;
}): ReactElement {
  const items: Array<{ mode: Mode; label: string; path: string }> = [
    ...(markdown
      ? [
          {
            mode: "preview" as const,
            label: "Preview",
            path: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
          },
        ]
      : []),
    { mode: "source", label: "Source", path: "m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" },
    ...(hasDiff
      ? [{ mode: "diff" as const, label: "Diff", path: "M8 3v18M16 3v18M4 7h8M12 17h8M16 13v8" }]
      : []),
  ];
  return (
    <nav className="viewer-controls" aria-label="File viewer controls">
      {items.map((item) => (
        <button
          key={item.mode}
          type="button"
          aria-label={item.label}
          title={item.label}
          aria-pressed={mode === item.mode}
          onClick={() => onMode(item.mode)}
        >
          <ControlIcon path={item.path} />
        </button>
      ))}
      <button
        type="button"
        aria-label="Refresh file"
        title="Refresh file"
        onClick={() => location.reload()}
      >
        <ControlIcon path="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
      </button>
    </nav>
  );
}
function ControlIcon({ path }: { path: string }): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
