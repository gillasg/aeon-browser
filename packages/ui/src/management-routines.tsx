import { useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementActionName } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { RoutineEditor } from "./management-routine-editor.js";

type Routine = ManagementSnapshotDto["routines"][number];
type Filter = "all" | "active" | "paused";

export function RoutinesPanel(props: ManagementSurfaceProps): ReactElement {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const routines = props.snapshot?.routines ?? [];
  const selected = routines.find((item) => item.routineId === selectedId);
  const visible = filterRoutines(routines, filter, query);
  if (creating) return <RoutineEditor props={props} onCancel={() => setCreating(false)} />;
  if (selected)
    return <RoutineDetail props={props} routine={selected} onBack={() => setSelectedId("")} />;
  return (
    <>
      <RoutineToolbar
        props={props}
        query={query}
        filter={filter}
        onQuery={setQuery}
        onFilter={setFilter}
        onCreate={() => setCreating(true)}
      />
      <RoutineList props={props} routines={visible} onSelect={setSelectedId} />
    </>
  );
}

function RoutineToolbar({
  props,
  query,
  filter,
  onQuery,
  onFilter,
  onCreate,
}: {
  props: ManagementSurfaceProps;
  query: string;
  filter: Filter;
  onQuery(value: string): void;
  onFilter(value: Filter): void;
  onCreate(): void;
}): ReactElement {
  return (
    <div className="management-toolbar">
      <input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Search routines"
        aria-label="Search routines"
      />
      <div role="group" aria-label="Routine status">
        {(["all", "active", "paused"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </button>
        ))}
      </div>
      <button type="button" disabled={!props.snapshot?.chats.length} onClick={onCreate}>
        New routine
      </button>
    </div>
  );
}

function RoutineList({
  props,
  routines,
  onSelect,
}: {
  props: ManagementSurfaceProps;
  routines: Routine[];
  onSelect(routineId: string): void;
}): ReactElement {
  if (!routines.length)
    return (
      <p className="management-empty">
        {props.loading ? "Loading routines…" : "No routines match this view."}
      </p>
    );
  return (
    <div className="management-list">
      {routines.map((routine) => (
        <button
          className="management-list-row"
          key={routine.routineId}
          type="button"
          onClick={() => onSelect(routine.routineId)}
        >
          <span>
            <strong>{routine.title}</strong>
            <small>
              For {routine.chatTitle} · Next{" "}
              {routine.nextDueAt ? new Date(routine.nextDueAt).toLocaleString() : "not scheduled"}
            </small>
          </span>
          <span className={`routine-status ${routine.enabled ? "enabled" : "paused"}`}>
            {routine.enabled ? "Active" : "Paused"} ›
          </span>
        </button>
      ))}
    </div>
  );
}

function RoutineDetail({
  props,
  routine,
  onBack,
}: {
  props: ManagementSurfaceProps;
  routine: Routine;
  onBack(): void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  if (editing)
    return <RoutineEditor props={props} routine={routine} onCancel={() => setEditing(false)} />;
  const toggle = () =>
    perform(props, routine.chatId, "update_routine", {
      routineId: routine.routineId,
      expectedRevision: routine.revision,
      title: routine.title,
      instruction: routine.instruction,
      schedule: routine.schedule,
      enabled: !routine.enabled,
      requiredBrowserInstanceId: routine.requiredBrowserInstanceId,
    });
  const remove = () => {
    if (window.confirm(`Delete “${routine.title}”?`))
      perform(props, routine.chatId, "delete_routine", {
        routineId: routine.routineId,
        expectedRevision: routine.revision,
      });
  };
  return (
    <div className="routine-detail">
      <button className="management-back" type="button" onClick={onBack}>
        ‹ All routines
      </button>
      <RoutineSummary routine={routine} />
      <h3>Instruction</h3>
      <pre className="routine-instruction">{routine.instruction}</pre>
      <RoutineActions
        routine={routine}
        onEdit={() => setEditing(true)}
        onRun={() =>
          perform(props, routine.chatId, "run_routine", { routineId: routine.routineId })
        }
        onToggle={toggle}
        onRemove={remove}
        onOpenChat={() => props.onOpenChat(routine.chatId)}
      />
      <RoutineRunHistory routine={routine} />
    </div>
  );
}

function RoutineSummary({ routine }: { routine: Routine }): ReactElement {
  return (
    <>
      <div className="management-card-heading">
        <div>
          <h2>{routine.title}</h2>
          <p>For {routine.chatTitle}</p>
        </div>
        <span className={`routine-status ${routine.enabled ? "enabled" : "paused"}`}>
          {routine.enabled ? "Active" : "Paused"}
        </span>
      </div>
      <dl className="management-facts">
        <div>
          <dt>Next run</dt>
          <dd>{routine.nextDueAt ? new Date(routine.nextDueAt).toLocaleString() : "Paused"}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>{scheduleLabel(routine.schedule)}</dd>
        </div>
      </dl>
    </>
  );
}

function RoutineActions({
  routine,
  onEdit,
  onRun,
  onToggle,
  onRemove,
  onOpenChat,
}: {
  routine: Routine;
  onEdit(): void;
  onRun(): void;
  onToggle(): void;
  onRemove(): void;
  onOpenChat(): void;
}): ReactElement {
  return (
    <div className="routine-actions">
      <button type="button" onClick={onEdit}>
        Edit
      </button>
      <button type="button" disabled={!routine.enabled} onClick={onRun}>
        Run now
      </button>
      <button type="button" onClick={onToggle}>
        {routine.enabled ? "Pause" : "Resume"}
      </button>
      <button type="button" onClick={onRemove}>
        Delete
      </button>
      <button type="button" onClick={onOpenChat}>
        Open Chat
      </button>
    </div>
  );
}

function RoutineRunHistory({ routine }: { routine: Routine }): ReactElement {
  return (
    <>
      <h3>Recent runs</h3>
      {routine.recentRuns.length ? (
        routine.recentRuns.map((run) => (
          <div className="routine-run" key={run.runId}>
            <span>{run.state}</span>
            <time>{new Date(run.createdAt).toLocaleString()}</time>
            {run.lastError && <p>{run.lastError}</p>}
          </div>
        ))
      ) : (
        <p className="management-empty">No runs yet.</p>
      )}
    </>
  );
}

function filterRoutines(routines: readonly Routine[], filter: Filter, query: string): Routine[] {
  const normalized = query.toLowerCase();
  return routines.filter((routine) => {
    const matchesFilter = filter === "all" || routine.enabled === (filter === "active");
    return (
      matchesFilter && `${routine.title} ${routine.chatTitle}`.toLowerCase().includes(normalized)
    );
  });
}

function perform(
  props: ManagementSurfaceProps,
  chatId: string,
  action: ManagementActionName,
  input: Record<string, unknown>,
): void {
  props.onAction(chatId, action, input);
}

function scheduleLabel(schedule: Routine["schedule"]): string {
  return schedule.kind === "interval"
    ? `Every ${schedule.everyMinutes} minutes · ${schedule.timeZone}`
    : `${schedule.daysOfWeek.join(", ")} at ${schedule.localTime} · ${schedule.timeZone}`;
}
