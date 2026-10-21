import type { ReactElement } from "react";
import type { ChatCatalogItemDto, HomeRoutineCardDto, ManagementSnapshotDto } from "@aeon/protocol";
import { MiniSwarm } from "./mini-swarm.js";
import { pauseReason } from "./management-routines.js";

// Under the ask box, in order of urgency: what needs you, what's running, what's being watched,
// then recent chats. Empty sections step aside so a quiet day is just the ask box.

type Routine = ManagementSnapshotDto["routines"][number];

export interface HomeDashboardProps {
  chats: readonly ChatCatalogItemDto[];
  runningChatIds: ReadonlySet<string>;
  needsChatIds?: ReadonlySet<string>;
  openChatIds?: ReadonlySet<string>;
  routines: readonly HomeRoutineCardDto[];
  /** Full watchers (with their check history) once management has loaded. */
  watchers?: readonly Routine[] | undefined;
  onOpenChat(chatId: string): void;
  onChats(): void;
  onWatchers(): void;
}

export function HomeDashboard(props: HomeDashboardProps): ReactElement {
  const needs = props.needsChatIds ?? new Set<string>();
  const live = props.chats.filter(
    (chat) => props.runningChatIds.has(chat.chatId) || needs.has(chat.chatId),
  );
  // Waiting on you sorts first.
  live.sort((left, right) => Number(needs.has(right.chatId)) - Number(needs.has(left.chatId)));
  const recent = props.chats.filter((chat) => !live.includes(chat)).slice(0, 8);
  return (
    <div className="home-dashboard">
      <LiveRuns chats={live} needs={needs} onOpenChat={props.onOpenChat} />
      <WatcherCards
        routines={props.routines}
        watchers={props.watchers}
        onWatchers={props.onWatchers}
      />
      <RecentChats
        chats={recent}
        openChatIds={props.openChatIds ?? new Set()}
        onOpenChat={props.onOpenChat}
        onChats={props.onChats}
      />
    </div>
  );
}

function LiveRuns({
  chats,
  needs,
  onOpenChat,
}: {
  chats: readonly ChatCatalogItemDto[];
  needs: ReadonlySet<string>;
  onOpenChat(chatId: string): void;
}): ReactElement | null {
  if (!chats.length) return null;
  return (
    <section className="home-block" aria-labelledby="home-running-heading">
      <BlockHeading id="home-running-heading" title="Running now" />
      <div className="home-grid">
        {chats.map((chat) => {
          const waiting = needs.has(chat.chatId);
          return (
            <button
              type="button"
              key={chat.chatId}
              className="home-card home-run-card"
              data-needs={String(waiting)}
              onClick={() => onOpenChat(chat.chatId)}
            >
              <span className="home-card-title">
                <MiniSwarm size={20} tone={waiting ? "needs" : "working"} />
                <span>{chat.title}</span>
              </span>
              <span className="home-card-line">
                {waiting ? "Needs you · open to answer" : "Working…"}
              </span>
              {waiting ? (
                <span className="home-card-action">Review</span>
              ) : (
                <span className="home-card-progress" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WatcherCards({
  routines,
  watchers,
  onWatchers,
}: {
  routines: readonly HomeRoutineCardDto[];
  watchers: readonly Routine[] | undefined;
  onWatchers(): void;
}): ReactElement {
  const cards = watchers?.length
    ? watchers.slice(0, 4).map((routine) => ({
        id: routine.routineId,
        title: routine.title,
        paused: !routine.enabled,
        line: fullLine(routine),
      }))
    : routines.map((routine) => ({
        id: routine.routineId,
        title: routine.title,
        paused: !routine.enabled,
        line: routine.enabled ? nextLine(routine.nextDueAt) : "Paused",
      }));
  return (
    <section className="home-block" aria-labelledby="home-watchers-heading">
      <BlockHeading
        id="home-watchers-heading"
        title="Watchers"
        more="All watchers"
        onMore={onWatchers}
      />
      {cards.length ? (
        <div className="home-grid">
          {cards.map((card) => (
            <button
              type="button"
              key={card.id}
              className="home-card home-watcher"
              data-paused={String(card.paused)}
              onClick={onWatchers}
            >
              <span className="home-card-title">
                <span>{card.title}</span>
              </span>
              <span className="home-card-line">{card.line}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="home-block-empty">
          Press Watch on a result and Aeon checks it every 15 minutes, telling you only when it
          changes.
        </p>
      )}
    </section>
  );
}

function RecentChats({
  chats,
  openChatIds,
  onOpenChat,
  onChats,
}: {
  chats: readonly ChatCatalogItemDto[];
  openChatIds: ReadonlySet<string>;
  onOpenChat(chatId: string): void;
  onChats(): void;
}): ReactElement {
  return (
    <section className="home-block" aria-labelledby="home-recent-heading">
      <BlockHeading
        id="home-recent-heading"
        title="Recent chats"
        more="All chats"
        onMore={onChats}
      />
      {chats.length ? (
        <div className="home-chips" id="recent-chats">
          {chats.map((chat) => (
            <button
              type="button"
              key={chat.chatId}
              className="home-chip"
              data-open={String(openChatIds.has(chat.chatId))}
              title={openChatIds.has(chat.chatId) ? `${chat.title} · open in a tab` : chat.title}
              onClick={() => onOpenChat(chat.chatId)}
            >
              {chat.title}
            </button>
          ))}
        </div>
      ) : (
        <p className="home-block-empty">Your recent chats will appear here.</p>
      )}
    </section>
  );
}

function BlockHeading({
  id,
  title,
  more,
  onMore,
}: {
  id: string;
  title: string;
  more?: string;
  onMore?(): void;
}): ReactElement {
  return (
    <div className="home-block-heading">
      <h2 id={id}>{title}</h2>
      {more && onMore && (
        <button type="button" onClick={onMore}>
          {more} →
        </button>
      )}
    </div>
  );
}

/** "Next at 3:15 PM · last check failed" or why it is paused. */
function fullLine(routine: Routine): string {
  if (!routine.enabled) return pauseReason(routine);
  const last = routine.recentRuns[0];
  const next = nextLine(routine.nextDueAt);
  if (!last) return next;
  if (last.state === "failed") return `${next} · last check failed`;
  return `${next} · checked ${clock(last.completedAt ?? last.createdAt)}`;
}

function nextLine(nextDueAt: string | null): string {
  if (!nextDueAt) return "Scheduled";
  const minutes = Math.round((Date.parse(nextDueAt) - Date.now()) / 60_000);
  if (minutes <= 0) return "Checking now";
  if (minutes < 60) return `Next in ${minutes} min`;
  return `Next at ${clock(nextDueAt)}`;
}

function clock(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
