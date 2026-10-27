import type { ReactElement } from "react";
import type { ChatCatalogItemDto, HomeRoutineCardDto, ManagementSnapshotDto } from "@aeon/protocol";
import { LiveRuns, RecentChats, type HomeRunActions, type HomeRunPreview } from "./home-live.js";
import { pauseReason } from "./management-routines.js";

// Under the ask box, in order of urgency: what needs you, what's running, what's being watched,
// then recent chats. Empty sections step aside so a quiet day is just the ask box.

type Routine = ManagementSnapshotDto["routines"][number];
type Pin = ManagementSnapshotDto["pins"][number];

export interface HomeDashboardProps {
  chats: readonly ChatCatalogItemDto[];
  runningChatIds: ReadonlySet<string>;
  needsChatIds?: ReadonlySet<string>;
  openChatIds?: ReadonlySet<string>;
  routines: readonly HomeRoutineCardDto[];
  /** Full watchers (with their check history) once management has loaded. */
  watchers?: readonly Routine[] | undefined;
  /** Answers kept on home, with their history. */
  pins?: readonly Pin[] | undefined;
  /** Live frames of the tabs running chats act in, by chat. */
  previews?: ReadonlyMap<string, HomeRunPreview>;
  runActions?: HomeRunActions | undefined;
  onOpenChat(chatId: string): void;
  onPin?(chat: ChatCatalogItemDto): void;
  onDelete?(chat: ChatCatalogItemDto): void;
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
  // Pinned chats stay on home above the latest ones.
  const rest = props.chats.filter((chat) => !live.includes(chat));
  const recent = [
    ...rest.filter((chat) => chat.pinned),
    ...rest.filter((chat) => !chat.pinned).slice(0, 5),
  ];
  return (
    <div className="home-dashboard">
      <LiveRuns
        chats={live}
        needs={needs}
        previews={props.previews ?? new Map()}
        actions={props.runActions}
        onOpenChat={props.onOpenChat}
      />
      <PinnedCards pins={props.pins} onOpenChat={props.onOpenChat} onRoutines={props.onWatchers} />
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
        onPin={props.onPin}
        onDelete={props.onDelete}
      />
    </div>
  );
}

function PinnedCards({
  pins,
  onOpenChat,
  onRoutines,
}: {
  pins: readonly Pin[] | undefined;
  onOpenChat(chatId: string): void;
  onRoutines(): void;
}): ReactElement | null {
  if (!pins?.length) return null;
  return (
    <section className="home-block" aria-labelledby="home-pins-heading">
      <BlockHeading id="home-pins-heading" title="Pinned" />
      <div className="home-grid">
        {pins.slice(0, 6).map((pin) => (
          <PinCard
            key={pin.pinId}
            pin={pin}
            onOpen={() => (pin.chatId ? onOpenChat(pin.chatId) : onRoutines())}
          />
        ))}
      </div>
    </section>
  );
}

function PinCard({ pin, onOpen }: { pin: Pin; onOpen(): void }): ReactElement {
  return (
    <button
      type="button"
      className="home-card home-pin"
      data-needs={String(Boolean(pin.needsYou))}
      title={pin.error ? `Last check failed: ${pin.error}` : (pin.condition ?? pin.title)}
      onClick={onOpen}
    >
      <span className="home-card-title">
        <span>{pin.title}</span>
        <span className="pin-tag">{pinTag(pin.source)}</span>
      </span>
      <span className="pin-value">{pin.value || "—"}</span>
      <PinSubline pin={pin} />
      <PinFoot pin={pin} />
    </button>
  );
}

/** The condition ("below ₹2,500") for a watcher, or what the saved answer adds. */
function PinSubline({ pin }: { pin: Pin }): ReactElement | null {
  if (pin.condition) return <span className="home-card-line pin-condition">{pin.condition}</span>;
  if (pin.detail) return <span className="home-card-line">{pin.detail}</span>;
  return null;
}

function PinFoot({ pin }: { pin: Pin }): ReactElement {
  const values = pin.history
    .map((point) => numberIn(point.value))
    .filter((value): value is number => value !== undefined);
  const change = valueChange(values);
  return (
    <span className="pin-foot">
      <PinChange change={change} failed={Boolean(pin.error)} />
      <Sparkline values={values} />
      <span className="pin-fresh">{freshness(pin.checkedAt ?? pin.updatedAt)}</span>
    </span>
  );
}

function PinChange({
  change,
  failed,
}: {
  change: number | undefined;
  failed: boolean;
}): ReactElement {
  if (change !== undefined && change !== 0)
    return (
      <span className="pin-change" data-direction={change < 0 ? "down" : "up"}>
        {change < 0 ? "↓" : "↑"} {Math.abs(change).toLocaleString()}
      </span>
    );
  return <span className="pin-change">{failed ? "check failed" : "steady"}</span>;
}

function valueChange(values: readonly number[]): number | undefined {
  const first = values[0];
  const last = values[values.length - 1];
  return first !== undefined && last !== undefined && values.length > 1 ? last - first : undefined;
}

/** The last few values as a tiny line, when there are enough numbers to say something. */
function Sparkline({ values }: { values: readonly number[] }): ReactElement | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .slice(-8)
    .map((value, index, shown) => {
      const x = shown.length === 1 ? 36 : (index / (shown.length - 1)) * 72;
      return `${x.toFixed(1)},${(22 - ((value - min) / span) * 18).toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="pin-spark" viewBox="0 0 72 24" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

/** "₹2,999" → 2999, "4 items: …" → 4; lines without a number are left out of the sparkline. */
function numberIn(text: string): number | undefined {
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function pinTag(source: Pin["source"]): string {
  if (source === "api") return "API";
  if (source === "routine") return "Check";
  return "Saved";
}

function freshness(at: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

function WatcherCards({
  routines,
  watchers,
  onWatchers,
}: {
  routines: readonly HomeRoutineCardDto[];
  watchers: readonly Routine[] | undefined;
  onWatchers(): void;
}): ReactElement | null {
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
  if (!cards.length) return null;
  return (
    <section className="home-block" aria-labelledby="home-watchers-heading">
      <BlockHeading
        id="home-watchers-heading"
        title="Routines"
        more="All routines"
        onMore={onWatchers}
      />
      {cards.length > 0 && (
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
