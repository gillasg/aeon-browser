import { useEffect, useRef, type ReactElement } from "react";
import { UI_BUILTIN_COMMANDS } from "./pi-native-command.js";
import type { PiUiSnapshotDto } from "@aeon/protocol";

export interface PiSessionPanelProps {
  snapshot: PiUiSnapshotDto | null;
  busy: boolean;
  onRefresh(): void;
  onClose?(): void;
  onNavigate(entryId: string): void;
  onInsertCommand(invocation: string): void;
  onCompact(): void;
}

export function PiSessionPanel(props: PiSessionPanelProps): ReactElement {
  const panel = useRef<HTMLElement>(null);
  usePanelDismiss(panel, props.onClose);
  return (
    <aside ref={panel} className="pi-session-panel" aria-label="Pi session tools">
      <header className="pi-session-heading">
        <h2>Pi session</h2>
        <button type="button" onClick={props.onRefresh} disabled={props.busy}>
          Refresh
        </button>
      </header>
      <div className="pi-session-columns">
        <TreeSection {...props} />
        <CommandSection {...props} />
      </div>
    </aside>
  );
}

function TreeSection({ snapshot, busy, onNavigate, onCompact }: PiSessionPanelProps): ReactElement {
  const allEntries = snapshot?.tree ?? [];
  const entries = allEntries.filter(
    (entry) => entry.currentLeaf || Boolean(entry.label?.trim() || entry.preview?.trim()),
  );
  const parentById = new Map(allEntries.map((entry) => [entry.entryId, entry.parentEntryId]));
  return (
    <section aria-labelledby="pi-tree-heading">
      <div className="management-card-heading">
        <h3 id="pi-tree-heading">Tree</h3>
        <button type="button" onClick={onCompact} disabled={busy}>
          Compact
        </button>
      </div>
      {entries.length ? (
        <div className="pi-tree-list">
          {entries.map((entry) => (
            <TreeEntry
              key={entry.entryId}
              entry={entry}
              depth={Math.min(3, entryDepth(entry, parentById))}
              busy={busy}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : (
        <p className="management-empty">
          {busy ? "Loading Pi session…" : "This Chat has no saved Pi entries yet."}
        </p>
      )}
    </section>
  );
}

function CommandSection({ snapshot, busy, onInsertCommand }: PiSessionPanelProps): ReactElement {
  const commands = snapshot?.slashCommands ?? [];
  return (
    <section aria-labelledby="pi-commands-heading">
      <h3 id="pi-commands-heading">Slash commands</h3>
      {commands.length ? (
        <div className="pi-command-list">
          {commands.map((command) => (
            <button
              className="pi-command-row"
              key={`${command.kind}:${command.invocation}`}
              type="button"
              disabled={
                busy || (command.kind === "builtin" && !UI_BUILTIN_COMMANDS.has(command.invocation))
              }
              title={
                command.kind === "builtin" && !UI_BUILTIN_COMMANDS.has(command.invocation)
                  ? "Available in the Pi terminal"
                  : command.description
              }
              onClick={() => onInsertCommand(command.invocation)}
            >
              <span>
                <strong>{command.invocation}</strong>
                <small>
                  {command.description}
                  {command.argumentHint ? ` · ${command.argumentHint}` : ""}
                </small>
              </span>
              <small>
                {command.kind === "builtin"
                  ? UI_BUILTIN_COMMANDS.has(command.invocation)
                    ? "Pi"
                    : "Pi terminal"
                  : command.kind}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <p className="management-empty">
          No Pi extension, skill, or prompt template commands are loaded.
        </p>
      )}
    </section>
  );
}

function TreeEntry({
  entry,
  depth,
  busy,
  onNavigate,
}: {
  entry: PiUiSnapshotDto["tree"][number];
  depth: number;
  busy: boolean;
  onNavigate(entryId: string): void;
}): ReactElement {
  return (
    <button
      className="pi-tree-entry"
      type="button"
      title={entry.preview ?? entry.label ?? undefined}
      aria-current={entry.currentLeaf ? "location" : undefined}
      disabled={busy}
      style={{ "--tree-depth": depth } as React.CSSProperties}
      onClick={() => onNavigate(entry.entryId)}
    >
      <span className="pi-tree-mark">{entry.currentLeaf ? "●" : "○"}</span>
      <span className="pi-tree-label">
        {entry.label?.trim() || entry.preview?.trim() || "Current position"}
      </span>
      <small>{entry.category === "message" ? "" : entry.category}</small>
    </button>
  );
}

function entryDepth(
  entry: PiUiSnapshotDto["tree"][number],
  parentById: ReadonlyMap<string, string | null>,
): number {
  let parent = entry.parentEntryId;
  let depth = 0;
  while (parent && depth < 12) {
    parent = parentById.get(parent) ?? null;
    depth += 1;
  }
  return depth;
}

function usePanelDismiss(
  panel: React.RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
): void {
  useEffect(() => {
    if (!onClose) return;
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || panel.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest("#pi-tools-toggle")) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      document.getElementById("pi-tools-toggle")?.focus();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [panel, onClose]);
}
