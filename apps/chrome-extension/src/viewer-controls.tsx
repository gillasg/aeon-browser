import { useState, type ReactElement } from "react";
type Mode = "preview" | "source" | "diff";
export function ViewerControls({
  mode,
  onMode,
  preview,
  hasDiff,
  path,
  chatId,
}: {
  mode: Mode;
  onMode(mode: Mode): void;
  preview: boolean;
  hasDiff: boolean;
  path: string;
  chatId: string;
}): ReactElement {
  const items = modeItems(preview, hasDiff);
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
      <CopyPathButton path={path} />
      <button
        type="button"
        aria-label="Ask Graft in this chat"
        title="Ask Graft in this chat"
        onClick={() => void openChat(chatId)}
      >
        <ControlIcon path="M4 5h16v11H9l-5 4z" />
      </button>
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

/** Back to the chat that produced this file: its open tab if there is one, else a new one. */
async function openChat(chatId: string): Promise<void> {
  const base = chrome.runtime.getURL("chat.html");
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => {
    if (!candidate.url?.startsWith(base)) return false;
    return new URL(candidate.url).searchParams.get("chatId") === chatId;
  });
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  const url = new URL(base);
  url.searchParams.set("chatId", chatId);
  await chrome.tabs.create({ url: url.href });
}

function CopyPathButton({ path }: { path: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Path copied" : "Copy path"}
      title={copied ? "Path copied" : "Copy path"}
      onClick={() =>
        void navigator.clipboard.writeText(path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <ControlIcon path={copied ? "m5 12 5 5 9-10" : "M9 9h11v11H9zM5 15H4V4h11v1"} />
    </button>
  );
}

function modeItems(
  preview: boolean,
  hasDiff: boolean,
): Array<{ mode: Mode; label: string; path: string }> {
  return [
    ...(preview
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
}
