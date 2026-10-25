import { randomUUID } from "node:crypto";
import type { AeonProductStore, ChatId, RoutineRecord } from "@aeon/domain";
import { exploreForRoutine } from "@aeon/pi-adapter";
import { nextRoutineOccurrence, parseRoutineSchedule } from "./routine-schedule.js";

// Routines for outside agents (the CLI and MCP). A routine created this way lives in a chat that
// the same caller created (origin cli or mcp); its alerts go to Aeon's UI only, never back to the
// caller. Pause and delete are limited to routines whose chat has the caller's own origin, so an
// outside agent cannot manage the user's routines. The user can always manage everything in Aeon.

export const EXTERNAL_ROUTINE_TOOL = {
  name: "routine",
  description:
    "Create, list, pause or delete an Aeon routine (a scheduled agent task). Its alerts appear in Aeon, not in this session. Only routines whose chat this origin created are listed or changed.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "pause", "delete"] },
      routineId: { type: "string", maxLength: 100 },
      chatId: { type: "string", maxLength: 100 },
      title: { type: "string", maxLength: 120 },
      instruction: { type: "string", maxLength: 20_000 },
      schedule: {
        description: 'A schedule object, or text such as "every 15 minutes" or "daily at 09:00".',
        anyOf: [{ type: "string", maxLength: 200 }, { type: "object" }],
      },
      check: {
        type: "string",
        maxLength: 20_000,
        description:
          "Optional browser_code that runs first; the agent run happens only when it returns true.",
      },
      sites: {
        type: "array",
        items: { type: "string", maxLength: 200 },
        maxItems: 10,
        description: "Only these sites during the routine's own run.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

type Origin = "cli" | "mcp";

export interface ExternalRoutineOptions {
  store: Pick<
    AeonProductStore,
    "createRoutine" | "listRoutines" | "getRoutine" | "updateRoutine" | "deleteRoutine"
  >;
  createChat(title: string, origin: Origin): Promise<{ chatId: ChatId }>;
  getChat(chatId: ChatId): { origin?: string } | undefined;
  /** The tool call's session: "mcp" or "cli". */
  session: string;
  args: Record<string, unknown>;
}

export async function runExternalRoutine(options: ExternalRoutineOptions): Promise<unknown> {
  const origin: Origin = options.session === "mcp" ? "mcp" : "cli";
  const action = requiredString(options.args.action, "action");
  if (action === "create") return create(options, origin);
  if (action === "list") return list(options, origin);
  if (action === "pause") return pause(options, origin);
  if (action === "delete") return remove(options, origin);
  throw new Error(`action must be create, list, pause or delete`);
}

async function create(options: ExternalRoutineOptions, origin: Origin): Promise<unknown> {
  const instruction = requiredString(options.args.instruction, "instruction");
  const title = optionalString(options.args.title).slice(0, 120) || instruction.slice(0, 60);
  const check = optionalString(options.args.check) || null;
  const checkShell = optionalString(options.args.checkShell) || null;
  const now = new Date();
  const schedule = parseRoutineSchedule(
    scheduleValue(options.args.schedule),
    now,
    check || checkShell ? 1 : 5,
  );
  const sites = sitesOf(options.args.sites);
  const chatId = await chatFor(options, origin);
  const timestamp = now.toISOString();
  const saved = options.store.createRoutine({
    routineId: randomUUID(),
    chatId,
    title,
    instruction,
    check,
    checkShell,
    sites,
    schedule,
    nextDueAt: nextRoutineOccurrence(schedule, now),
    requiredBrowserInstanceId: null,
    enabled: true,
    deletedAt: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  exploreForRoutine([title, instruction, JSON.stringify(check ?? "")].join(" "));
  return project(saved);
}

async function chatFor(options: ExternalRoutineOptions, origin: Origin): Promise<ChatId> {
  const given = optionalString(options.args.chatId);
  if (!given) {
    const chat = await options.createChat(
      String(options.args.title ?? "Routine").slice(0, 120),
      origin,
    );
    return chat.chatId;
  }
  const chatId = given as ChatId;
  const chat = options.getChat(chatId);
  if (!chat) throw new Error(`No chat ${given}`);
  if (chat.origin !== origin)
    throw new Error(
      `Chat ${given} was not created by ${origin}; create the routine in a new chat (omit chatId) or let the user add it in Aeon.`,
    );
  return chatId;
}

function list(options: ExternalRoutineOptions, origin: Origin): unknown[] {
  return options.store
    .listRoutines()
    .filter((routine) => !routine.deletedAt && options.getChat(routine.chatId)?.origin === origin)
    .map(project);
}

function pause(options: ExternalRoutineOptions, origin: Origin): unknown {
  const routine = owned(options, origin);
  if (!routine.enabled) return project(routine);
  return project(
    options.store.updateRoutine(
      routine.routineId,
      routine.revision,
      {
        title: routine.title,
        instruction: routine.instruction,
        check: routine.check ?? null,
        checkShell: routine.checkShell ?? null,
        sites: routine.sites ?? [],
        schedule: routine.schedule,
        requiredBrowserInstanceId: routine.requiredBrowserInstanceId ?? null,
        enabled: false,
        nextDueAt: null,
      },
      new Date().toISOString(),
    ),
  );
}

function remove(options: ExternalRoutineOptions, origin: Origin): unknown {
  const routine = owned(options, origin);
  options.store.deleteRoutine(routine.routineId, routine.revision, new Date().toISOString());
  return { routineId: routine.routineId, deleted: true };
}

function owned(options: ExternalRoutineOptions, origin: Origin): RoutineRecord {
  const routineId = requiredString(options.args.routineId, "routineId");
  const routine = options.store.getRoutine(routineId);
  if (!routine || routine.deletedAt) throw new Error(`No routine ${routineId}`);
  if (options.getChat(routine.chatId)?.origin !== origin)
    throw new Error(
      `Routine ${routineId} was not created by ${origin}; the user manages it in Aeon Settings.`,
    );
  return routine;
}

function project(routine: RoutineRecord): Record<string, unknown> {
  return {
    routineId: routine.routineId,
    chatId: routine.chatId,
    title: routine.title,
    instruction: routine.instruction,
    schedule: routine.schedule,
    nextDueAt: routine.nextDueAt,
    enabled: routine.enabled,
    sites: routine.sites ?? [],
    check: Boolean(routine.check),
    createdAt: routine.createdAt,
  };
}

function sitesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 10);
}

/** Text schedules for CLI/MCP callers; objects go to parseRoutineSchedule as they are. */
function scheduleValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim().toLowerCase();
  const every = /^every\s+(\d+)\s*(minute|minutes|min|hour|hours|h)$/.exec(text);
  if (every) {
    const minutes = Number(every[1] ?? 0) * ((every[2] ?? "").startsWith("h") ? 60 : 1);
    return { kind: "interval", everyMinutes: minutes };
  }
  const daily = /^(?:daily|every day)(?:\s+at\s+([0-2]?\d:[0-5]\d))?$/.exec(text);
  if (daily)
    return {
      kind: "calendar",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      localTime: daily[1]?.padStart(5, "0") ?? "09:00",
    };
  return value;
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value).trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
