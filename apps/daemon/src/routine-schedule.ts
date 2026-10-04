import type { RoutineSchedule } from "@pippin/domain";

const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_INTERVAL_MINUTES = 525_600;

export function parseRoutineSchedule(value: unknown, now = new Date()): RoutineSchedule {
  if (!isRecord(value)) throw new Error("Routine schedule must be an object.");
  const timeZone =
    value.timeZone === undefined ? localTimeZone() : requiredString(value.timeZone, 80);
  formatter(timeZone);
  if (value.kind === "interval") {
    const everyMinutes = integer(value.everyMinutes, 5, MAX_INTERVAL_MINUTES, "everyMinutes");
    const anchorUtc =
      value.anchorUtc === undefined ? now.toISOString() : requiredString(value.anchorUtc, 40);
    if (!Number.isFinite(Date.parse(anchorUtc)))
      throw new Error("anchorUtc must be an ISO date-time.");
    return {
      kind: "interval",
      everyMinutes,
      anchorUtc: new Date(anchorUtc).toISOString(),
      timeZone,
    };
  }
  if (value.kind === "calendar") {
    if (!Array.isArray(value.daysOfWeek) || !value.daysOfWeek.length)
      throw new Error("Calendar schedules need at least one weekday.");
    const daysOfWeek = [
      ...new Set(value.daysOfWeek.map((day) => integer(day, 0, 6, "weekday"))),
    ].sort();
    const localTime = requiredString(value.localTime, 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime))
      throw new Error("localTime must use 24-hour HH:mm format.");
    return { kind: "calendar", daysOfWeek, localTime, timeZone };
  }
  throw new Error("Routine schedule kind must be interval or calendar.");
}

export function nextRoutineOccurrence(schedule: RoutineSchedule, after: string | Date): string {
  const afterMs = typeof after === "string" ? Date.parse(after) : after.getTime();
  if (!Number.isFinite(afterMs)) throw new Error("Routine reference time is invalid.");
  if (schedule.kind === "interval") return nextInterval(schedule, afterMs);
  return nextCalendar(schedule, afterMs);
}

export function collectDueSlots(
  schedule: RoutineSchedule,
  firstDueAt: string,
  now: string,
): {
  slots: string[];
  nextDueAt: string;
} {
  const currentTime = Date.parse(now);
  let slot = firstDueAt;
  const slots: string[] = [];
  while (Date.parse(slot) <= currentTime) {
    slots.push(slot);
    slot = nextRoutineOccurrence(schedule, slot);
  }
  return { slots, nextDueAt: slot };
}

export function previewCalendar(
  schedule: RoutineSchedule,
  after = new Date(),
  count = 3,
): string[] {
  const next: string[] = [];
  let cursor: string | Date = after;
  for (let index = 0; index < count; index += 1) {
    const occurrence = nextRoutineOccurrence(schedule, cursor);
    next.push(occurrence);
    cursor = occurrence;
  }
  return next;
}

function nextInterval(
  schedule: Extract<RoutineSchedule, { kind: "interval" }>,
  afterMs: number,
): string {
  const anchor = Date.parse(schedule.anchorUtc);
  const interval = schedule.everyMinutes * 60_000;
  const steps = Math.max(0, Math.floor((afterMs - anchor) / interval) + 1);
  return new Date(anchor + steps * interval).toISOString();
}

function nextCalendar(
  schedule: Extract<RoutineSchedule, { kind: "calendar" }>,
  afterMs: number,
): string {
  const local = partsAt(afterMs, schedule.timeZone);
  const start = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  for (let offset = 0; offset < 15; offset += 1) {
    const date = new Date(start.getTime() + offset * 86_400_000);
    if (!schedule.daysOfWeek.includes(date.getUTCDay())) continue;
    const occurrence = resolveLocalMinute(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour ?? 0,
      minute ?? 0,
      schedule.timeZone,
    );
    if (occurrence > afterMs) return new Date(occurrence).toISOString();
  }
  throw new Error("Could not find a calendar occurrence in the next two weeks.");
}

function resolveLocalMinute(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = naive + delta * 3_600_000;
    const parts = partsAt(probe, timeZone);
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    offsets.add(localAsUtc - Math.floor(probe / 60_000) * 60_000);
  }
  const exact: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    const parts = partsAt(candidate, timeZone);
    if (matches(parts, year, month, day, hour, minute)) exact.push(candidate);
  }
  if (exact.length) return Math.min(...exact);

  // A missing daylight-saving wall time resolves to that day's first later valid minute.
  for (
    let candidate = naive - 14 * 3_600_000;
    candidate <= naive + 14 * 3_600_000;
    candidate += 60_000
  ) {
    const parts = partsAt(candidate, timeZone);
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour * 60 + parts.minute > hour * 60 + minute
    )
      return candidate;
  }
  throw new Error("Could not resolve the local calendar time.");
}

function partsAt(timestamp: number, timeZone: string): WallParts {
  const parts = formatter(timeZone).formatToParts(new Date(timestamp));
  const read = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, created);
  return created;
}

function matches(
  parts: WallParts,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute
  );
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value as number;
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(`Schedule text must contain 1–${maxLength} characters.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
