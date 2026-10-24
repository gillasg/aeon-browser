import {
  useState,
  type FormEvent,
  type ReactElement,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementActionName } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import type { RoutineDraftSeed } from "./routine-draft-route.js";

type Routine = ManagementSnapshotDto["routines"][number];
type ScheduleKind = "interval" | "calendar";
interface RoutineDraft {
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  chatId: string;
  setChatId: Dispatch<SetStateAction<string>>;
  instruction: string;
  setInstruction: Dispatch<SetStateAction<string>>;
  sites: string;
  setSites: Dispatch<SetStateAction<string>>;
  kind: ScheduleKind;
  setKind: Dispatch<SetStateAction<ScheduleKind>>;
  everyMinutes: string;
  setEveryMinutes: Dispatch<SetStateAction<string>>;
  daysOfWeek: string;
  setDaysOfWeek: Dispatch<SetStateAction<string>>;
  localTime: string;
  setLocalTime: Dispatch<SetStateAction<string>>;
  timeZone: string;
  setTimeZone: Dispatch<SetStateAction<string>>;
  browserInstanceId: string;
  setBrowserInstanceId: Dispatch<SetStateAction<string>>;
}

export function RoutineEditor({
  props,
  routine,
  initial,
  onCancel,
}: {
  props: ManagementSurfaceProps;
  routine?: Routine;
  /** Prefill for a new routine (ignored when editing an existing one). */
  initial?: RoutineDraftSeed;
  onCancel(): void;
}): ReactElement {
  const draft = useRoutineDraft(props, routine, routine ? undefined : initial);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    perform(props, draft.chatId, routine ? "update_routine" : "create_routine", {
      title: draft.title,
      instruction: draft.instruction,
      sites: draft.sites
        .split(/[\s,]+/)
        .map((site) => site.trim())
        .filter(Boolean),
      schedule: makeSchedule(draft),
      enabled: routine?.enabled ?? true,
      requiredBrowserInstanceId: draft.browserInstanceId.trim() || null,
      ...(routine ? { routineId: routine.routineId, expectedRevision: routine.revision } : {}),
    });
    onCancel();
  };
  return (
    <form className="routine-editor" onSubmit={submit}>
      <button className="management-back" type="button" onClick={onCancel}>
        ‹ Cancel
      </button>
      <h2>{routine ? "Edit routine" : "New routine"}</h2>
      <RoutineIdentityFields props={props} draft={draft} />
      <RoutineScheduleFields draft={draft} />
      <RoutineTargetFields draft={draft} />
      <p>
        Next run is calculated in {draft.timeZone}. The routine always runs in its selected Chat.
      </p>
      <button type="submit" disabled={!draft.chatId}>
        Save routine
      </button>
    </form>
  );
}

function useRoutineDraft(
  props: ManagementSurfaceProps,
  routine?: Routine,
  initial?: RoutineDraftSeed,
): RoutineDraft {
  const start = startingValues(props, routine, initial);
  const [title, setTitle] = useState(start.title);
  const [chatId, setChatId] = useState(start.chatId);
  const [instruction, setInstruction] = useState(start.instruction);
  const [sites, setSites] = useState(routine?.sites.join(", ") ?? "");
  const [kind, setKind] = useState<ScheduleKind>(initialScheduleKind(routine));
  const [everyMinutes, setEveryMinutes] = useState(start.everyMinutes);
  const [daysOfWeek, setDaysOfWeek] = useState(initialDaysOfWeek(routine?.schedule));
  const [localTime, setLocalTime] = useState(initialLocalTime(routine?.schedule));
  const [timeZone, setTimeZone] = useState(initialTimeZone(routine?.schedule));
  const [browserInstanceId, setBrowserInstanceId] = useState(
    routine?.requiredBrowserInstanceId ?? "",
  );
  return {
    title,
    setTitle,
    chatId,
    setChatId,
    instruction,
    setInstruction,
    sites,
    setSites,
    kind,
    setKind,
    everyMinutes,
    setEveryMinutes,
    daysOfWeek,
    setDaysOfWeek,
    localTime,
    setLocalTime,
    timeZone,
    setTimeZone,
    browserInstanceId,
    setBrowserInstanceId,
  };
}

/** An existing routine wins; otherwise a prefilled draft (from the orb's Watch); otherwise blank. */
function startingValues(
  props: ManagementSurfaceProps,
  routine?: Routine,
  initial?: RoutineDraftSeed,
): { title: string; chatId: string; instruction: string; everyMinutes: string } {
  return {
    title: routine?.title ?? initial?.title ?? "",
    chatId: initial?.chatId ?? initialChatId(props, routine),
    instruction: routine?.instruction ?? initial?.instruction ?? "",
    everyMinutes: startingMinutes(routine, initial),
  };
}

function startingMinutes(routine?: Routine, initial?: RoutineDraftSeed): string {
  return initial ? String(initial.everyMinutes) : initialIntervalMinutes(routine?.schedule);
}

function initialChatId(props: ManagementSurfaceProps, routine?: Routine): string {
  return routine?.chatId ?? props.snapshot?.chats[0]?.chatId ?? "";
}

function initialScheduleKind(routine?: Routine): ScheduleKind {
  return routine?.schedule.kind ?? "interval";
}

function initialIntervalMinutes(schedule?: Routine["schedule"]): string {
  return schedule?.kind === "interval" ? String(schedule.everyMinutes) : "60";
}

function initialDaysOfWeek(schedule?: Routine["schedule"]): string {
  return schedule?.kind === "calendar" ? schedule.daysOfWeek.join(",") : "1,2,3,4,5";
}

function initialLocalTime(schedule?: Routine["schedule"]): string {
  return schedule?.kind === "calendar" ? schedule.localTime : "09:00";
}

function initialTimeZone(schedule?: Routine["schedule"]): string {
  return schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function RoutineIdentityFields({
  props,
  draft,
}: {
  props: ManagementSurfaceProps;
  draft: RoutineDraft;
}): ReactElement {
  return (
    <>
      <label>
        Name
        <input
          value={draft.title}
          onChange={(event) => draft.setTitle(event.target.value)}
          required
          maxLength={120}
        />
      </label>
      <label>
        Chat
        <select
          value={draft.chatId}
          onChange={(event) => draft.setChatId(event.target.value)}
          required
        >
          {props.snapshot?.chats.map((chat) => (
            <option key={chat.chatId} value={chat.chatId}>
              {chat.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Instruction
        <textarea
          value={draft.instruction}
          onChange={(event) => draft.setInstruction(event.target.value)}
          required
          maxLength={20_000}
          rows={5}
        />
      </label>
      <label>
        Only these sites (optional)
        <input
          value={draft.sites}
          onChange={(event) => draft.setSites(event.target.value)}
          maxLength={1000}
          placeholder="example.com, shop.example.com"
        />
      </label>
    </>
  );
}

function RoutineScheduleFields({ draft }: { draft: RoutineDraft }): ReactElement {
  return (
    <>
      <label>
        Schedule type
        <select
          value={draft.kind}
          onChange={(event) => draft.setKind(event.target.value as ScheduleKind)}
        >
          <option value="interval">Every N minutes</option>
          <option value="calendar">Selected weekdays</option>
        </select>
      </label>
      {draft.kind === "interval" ? (
        <IntervalFields draft={draft} />
      ) : (
        <CalendarFields draft={draft} />
      )}
    </>
  );
}

function IntervalFields({ draft }: { draft: RoutineDraft }): ReactElement {
  return (
    <label>
      Minutes
      <input
        type="number"
        min="1"
        max="525600"
        value={draft.everyMinutes}
        onChange={(event) => draft.setEveryMinutes(event.target.value)}
        required
      />
    </label>
  );
}

function CalendarFields({ draft }: { draft: RoutineDraft }): ReactElement {
  return (
    <>
      <label>
        Weekdays (0=Sun, comma separated)
        <input
          value={draft.daysOfWeek}
          onChange={(event) => draft.setDaysOfWeek(event.target.value)}
          required
          pattern="[0-6](,[0-6])*"
        />
      </label>
      <label>
        Local time
        <input
          type="time"
          value={draft.localTime}
          onChange={(event) => draft.setLocalTime(event.target.value)}
          required
        />
      </label>
    </>
  );
}

function RoutineTargetFields({ draft }: { draft: RoutineDraft }): ReactElement {
  return (
    <>
      <label>
        Time zone
        <input
          value={draft.timeZone}
          onChange={(event) => draft.setTimeZone(event.target.value)}
          required
          maxLength={100}
        />
      </label>
      <label>
        Required browser instance ID (optional)
        <input
          value={draft.browserInstanceId}
          onChange={(event) => draft.setBrowserInstanceId(event.target.value)}
          pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
          placeholder="Leave blank for any browser"
        />
      </label>
    </>
  );
}

function makeSchedule(draft: RoutineDraft): Routine["schedule"] {
  if (draft.kind === "interval")
    return {
      kind: "interval",
      everyMinutes: Number(draft.everyMinutes),
      anchorUtc: new Date().toISOString(),
      timeZone: draft.timeZone,
    };
  return {
    kind: "calendar",
    daysOfWeek: draft.daysOfWeek.split(",").map(Number),
    localTime: draft.localTime,
    timeZone: draft.timeZone,
  };
}

function perform(
  props: ManagementSurfaceProps,
  chatId: string,
  action: ManagementActionName,
  input: Record<string, unknown>,
): void {
  props.onAction(chatId, action, input);
}
