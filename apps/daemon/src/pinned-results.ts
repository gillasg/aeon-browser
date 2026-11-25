import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RoutineRecord } from "@aeon/domain";
import { siteMapperRequest } from "@aeon/pi-adapter";

// Pinned results: answers the user wants to keep on the new-tab home, with their history. A pin
// backed by a site API call refreshes itself with no model; a watcher (a routine with a check)
// updates its pin on every check; a saved answer stays as it was until it is pinned again.

export interface PinHistoryPoint {
  at: string;
  value: string;
}

export interface PinRecord {
  pinId: string;
  title: string;
  value: string;
  detail?: string;
  /** "tell me if it drops under ₹2,500", from a watcher. */
  condition?: string;
  source: "api" | "routine" | "answer";
  site?: string;
  operation?: string;
  params?: Record<string, unknown>;
  chatId?: string;
  routineId?: string;
  createdAt: string;
  updatedAt: string;
  checkedAt: string | null;
  refreshMinutes?: number;
  /** The last check passed: this pin is waiting for the user. */
  needsYou?: boolean;
  error?: string;
  history: PinHistoryPoint[];
}

interface PinnedFile {
  pins: PinRecord[];
}

const MAX_PINS = 50;
const MAX_HISTORY = 12;
const DEFAULT_REFRESH_MINUTES = 15;
const MAX_VALUE = 200;
const REFRESH_EVERY_MS = 60_000;

export class PinnedResults {
  private pins: PinRecord[] | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = join(dataRoot, "pinned-results.json");
  }

  async start(): Promise<void> {
    await this.load();
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshDue(), REFRESH_EVERY_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async list(): Promise<PinRecord[]> {
    const pins = await this.load();
    return [...pins].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Every watcher check updates its pin, whether or not the condition passed: that is the
   * before → after history, and it costs no model call.
   */
  async recordCheck(
    routine: RoutineRecord,
    check: { met: boolean; value?: unknown; error?: string },
  ): Promise<void> {
    if (!routine.check || routine.deletedAt) return;
    const existing = (await this.load()).find((pin) => pin.routineId === routine.routineId);
    const pin = routinePin(routine, check, existing);
    if (!pin) return;
    await this.replace(pin);
  }

  /** Refreshes a pin from its site API call; no model, no tabs of its own. */
  async refresh(pinId: string): Promise<void> {
    const pin = (await this.load()).find((item) => item.pinId === pinId);
    if (!pin || pin.source !== "api" || !pin.site || !pin.operation) return;
    const pending = siteMapperRequest("aeon-pins", {
      siteMapper: "call",
      site: pin.site,
      operation: pin.operation,
      params: pin.params ?? {},
    });
    const now = new Date().toISOString();
    try {
      if (!pending) throw new Error("Aeon's browser is not connected");
      const value = pinValue(await pending);
      await this.replace({
        ...pin,
        value,
        updatedAt: now,
        checkedAt: now,
        history: pushHistory(pin.history, value, now),
      });
    } catch (error) {
      await this.replace({
        ...pin,
        updatedAt: now,
        checkedAt: now,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }

  private async refreshDue(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      for (const pin of await this.load()) {
        if (pin.source !== "api") continue;
        const every = (pin.refreshMinutes ?? DEFAULT_REFRESH_MINUTES) * 60_000;
        const checked = pin.checkedAt ? Date.parse(pin.checkedAt) : 0;
        if (Number.isFinite(checked) && now - checked < every) continue;
        await this.refresh(pin.pinId);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async replace(pin: PinRecord): Promise<void> {
    const pins = await this.load();
    const index = pins.findIndex((item) => item.pinId === pin.pinId);
    if (index >= 0) pins[index] = pin;
    else pins.unshift(pin);
    await this.save({ pins: pins.slice(0, MAX_PINS) });
  }

  private async load(): Promise<PinRecord[]> {
    if (this.pins) return this.pins;
    try {
      const file = JSON.parse(await readFile(this.file, "utf8")) as Partial<PinnedFile>;
      this.pins = Array.isArray(file.pins) ? file.pins.filter(isPin) : [];
    } catch {
      this.pins = [];
    }
    return this.pins;
  }

  private async save(file: PinnedFile): Promise<void> {
    this.pins = file.pins;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

/** "₹2,999", "12 items", "In stock" from whatever an API operation returns. */
export function pinValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, MAX_VALUE);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return arrayValue(value);
  return recordValue(value as Record<string, unknown>);
}

function arrayValue(items: readonly unknown[]): string {
  if (!items.length) return "None";
  const first = pinValue(items[0]);
  return (items.length === 1 ? first : `${items.length} items: ${first}`).slice(0, MAX_VALUE);
}

function recordValue(record: Record<string, unknown>): string {
  if (Array.isArray(record.items)) return record.items.length ? arrayValue(record.items) : "None";
  const price = record.price ?? record.amount ?? record.value;
  const name = [record.title, record.name, record.text, record.summary, record.label].find(
    (field) => typeof field === "string" && field,
  ) as string | undefined;
  if (name !== undefined || price !== undefined)
    return [name, price === undefined ? "" : String(price)]
      .filter(Boolean)
      .join(" · ")
      .slice(0, MAX_VALUE);
  return JSON.stringify(record).slice(0, MAX_VALUE);
}

/** The pin a watcher's check updates, or undefined when there is nothing to show yet. */
function routinePin(
  routine: RoutineRecord,
  check: { met: boolean; value?: unknown; error?: string },
  existing: PinRecord | undefined,
): PinRecord | undefined {
  const shown = checkedValue(routine, check, existing);
  if (!existing && !shown) return undefined;
  const now = new Date().toISOString();
  const pin: PinRecord = {
    pinId: existing?.pinId ?? randomUUID(),
    title: existing?.title ?? routine.title,
    value: shown,
    ...routineExtras(routine, check, existing),
    source: "routine",
    chatId: routine.chatId,
    routineId: routine.routineId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    checkedAt: now,
    needsYou: check.met,
    history: pushHistory(existing?.history, shown, now),
  };
  return pin;
}

function checkedValue(
  routine: RoutineRecord,
  check: { met: boolean; value?: unknown },
  existing: PinRecord | undefined,
): string {
  const value = check.value === undefined ? "" : pinValue(check.value);
  if (value) return value;
  // A boolean check says only whether it passed; its value is the routine's own title.
  if (check.met) return routine.title;
  return existing?.value ?? "";
}

function routineExtras(
  routine: RoutineRecord,
  check: { error?: string },
  existing: PinRecord | undefined,
): Partial<PinRecord> {
  const extras: Partial<PinRecord> = {};
  if (existing?.detail) extras.detail = existing.detail;
  const condition = existing?.condition ?? routine.instruction;
  if (condition) extras.condition = condition.slice(0, 200);
  if (check.error) extras.error = check.error.slice(0, 500);
  return extras;
}

/** Adds a history point only when the value changed, so a sparkline shows changes, not checks. */
export function pushHistory(
  history: readonly PinHistoryPoint[] | undefined,
  value: string,
  at: string,
): PinHistoryPoint[] {
  const previous = history ?? [];
  if (!value) return previous.slice(-MAX_HISTORY);
  const last = previous[previous.length - 1];
  if (last?.value === value) return previous.slice(-MAX_HISTORY);
  return [...previous, { at, value: value.slice(0, MAX_VALUE) }].slice(-MAX_HISTORY);
}

function isPin(value: unknown): value is PinRecord {
  const pin = value as Partial<PinRecord> | null;
  return (
    typeof pin?.pinId === "string" &&
    typeof pin.title === "string" &&
    typeof pin.value === "string" &&
    typeof pin.updatedAt === "string" &&
    Array.isArray(pin.history)
  );
}
