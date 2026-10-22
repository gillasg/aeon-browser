import type { ReactElement } from "react";
import type { ActivityEntry } from "./activity-log.js";

// Activity: only the things Aeon changed on sites, newest first, grouped by day. Undo appears
// only where the site lets the change be reversed.

export function ActivityPanel({
  entries,
  onOpenChat,
  onUndo,
}: {
  entries: readonly ActivityEntry[];
  onOpenChat(chatId: string): void;
  onUndo?(entry: ActivityEntry): void;
}): ReactElement {
  return (
    <section className="management-main activity-page" aria-label="Activity">
      <header className="management-heading">
        <div>
          <h1>Activity</h1>
          <p className="activity-lede">
            What Aeon changed on sites for you: forms sent, items changed in bulk, orders, messages,
            bookings.
          </p>
        </div>
      </header>
      {entries.length ? (
        days(entries).map(([day, items]) => (
          <section key={day} className="activity-day" aria-label={day}>
            <h2>{day}</h2>
            {items.map((entry) => (
              <ActivityRow
                key={entry.id}
                entry={entry}
                onOpenChat={onOpenChat}
                {...(onUndo ? { onUndo } : {})}
              />
            ))}
          </section>
        ))
      ) : (
        <p className="management-empty">
          Nothing yet. When Aeon types into a site or sends something, it shows here.
        </p>
      )}
    </section>
  );
}

function ActivityRow({
  entry,
  onOpenChat,
  onUndo,
}: {
  entry: ActivityEntry;
  onOpenChat(chatId: string): void;
  onUndo?(entry: ActivityEntry): void;
}): ReactElement {
  return (
    <div className="activity-row">
      <time dateTime={entry.at}>
        {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
      <div className="activity-what">
        <strong>{entry.summary}</strong>
        <span>
          {entry.host && <>{entry.host} · </>}
          {entry.task}
        </span>
        {entry.items?.length ? (
          <details className="activity-items">
            <summary>
              {entry.items.length} item{entry.items.length === 1 ? "" : "s"}
            </summary>
            <ul>
              {entry.items.map((item, index) => (
                <li key={index}>{item || "(no label)"}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="activity-row-actions">
        {entry.undo && (
          <button type="button" onClick={() => onUndo?.(entry)}>
            {entry.undo.label}
          </button>
        )}
        <button type="button" onClick={() => onOpenChat(entry.chatId)}>
          Open chat
        </button>
      </div>
    </div>
  );
}

function days(entries: readonly ActivityEntry[]): Array<[string, ActivityEntry[]]> {
  const groups = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const day = dayLabel(new Date(entry.at));
    groups.set(day, [...(groups.get(day) ?? []), entry]);
  }
  return [...groups];
}

function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
