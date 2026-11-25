import { randomUUID } from "node:crypto";
import type { ChatId, AeonProductStore, RoutineRecord } from "@aeon/domain";
import {
  inferRoutineEffect,
  optionalBoolean,
  parseEffect,
  parseWebhook,
} from "./routine-fields.js";
import { optionalListen } from "./routine-listen.js";
import { nextRoutineOccurrence, parseRoutineSchedule } from "./routine-schedule.js";
import type { RoutineScheduler } from "./routine-scheduler.js";
import { exploreForRoutine } from "@aeon/pi-adapter";

const ROUTINE_TOOLS = new Set([
  "create_routine",
  "preview_routine_schedule",
  "update_routine",
  "list_routines",
  "run_routine",
  "delete_routine",
]);

export function isRoutineTool(name: string): boolean {
  return ROUTINE_TOOLS.has(name);
}

export class RoutineManagementTools {
  constructor(
    private readonly store: AeonProductStore,
    private readonly routines: RoutineScheduler,
  ) {}

  execute(name: string, args: Record<string, unknown>, chatId: ChatId): unknown {
    switch (name) {
      case "create_routine":
        return this.create(args, chatId);
      case "preview_routine_schedule":
        return previewSchedule(args.schedule);
      case "update_routine":
        return this.update(args, chatId);
      case "list_routines":
        return this.store.listRoutines(chatId).map((routine) => ({
          ...routine,
          webhook: routine.webhook
            ? {
                url: routine.webhook.url,
                ...(routine.webhook.secret ? { hasSecret: true } : {}),
              }
            : null,
          recentRuns: this.store.listRoutineRuns(routine.routineId, 10),
        }));
      case "run_routine":
        return this.run(args, chatId);
      case "delete_routine":
        return this.remove(args, chatId);
      default:
        throw new Error(`Unknown daemon routine tool '${name}'.`);
    }
  }

  private create(
    args: Record<string, unknown>,
    chatId: ChatId,
  ): RoutineRecord & { warning?: string } {
    const now = new Date();
    const title = requiredString(args.title, "title");
    const instruction = requiredString(args.instruction, "instruction");
    const check = optionalCheck(args.check, null);
    const checkShell = optionalShellCheck(args.checkShell, null);
    const listen = optionalListen(args.listen);
    const webhook = parseWebhook(args.webhook, args.webhookSecret, null);
    const webhookOnly = optionalBoolean(args.webhookOnly, "webhookOnly", false);
    const schedule = parseRoutineSchedule(
      args.schedule,
      now,
      check || checkShell || listen ? 1 : 5,
    );
    const timestamp = now.toISOString();
    const routineId = randomUUID();
    const saved = this.store.createRoutine({
      routineId,
      chatId,
      title,
      instruction,
      check,
      checkShell,
      sites: optionalSites(args.sites, []),
      listen,
      schedule,
      nextDueAt: nextRoutineOccurrence(schedule, now, routineId),
      // A routine runs in its chat's browser: with several Chrome profiles connected, a check with
      // no browser fails AMBIGUOUS_BROWSER on every run and the watcher never fires.
      requiredBrowserInstanceId:
        optionalNullableUuid(args.requiredBrowserInstanceId, "requiredBrowserInstanceId") ??
        this.routines.browserForChat(chatId) ??
        null,
      webhook,
      webhookOnly,
      effect: inferRoutineEffect({
        title,
        instruction,
        check,
        webhookOnly,
        override: parseEffect(args.effect),
      }),
      enabled: true,
      deletedAt: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    // A routine on a site with no learned read gets that site explored, so its checks can use
    // the site's API.
    exploreForRoutine(
      [saved.title, saved.instruction, JSON.stringify(saved.check ?? "")].join(" "),
    );
    return withWarning(this.store.getRoutine(saved.routineId) ?? saved);
  }

  private update(
    args: Record<string, unknown>,
    chatId: ChatId,
  ): RoutineRecord & { warning?: string } {
    const id = requiredString(args.routineId, "routineId");
    const current = this.requireOwned(id, chatId);
    const check = optionalCheck(args.check, current.check);
    const checkShell = optionalShellCheck(args.checkShell, current.checkShell);
    const listen = optionalListen(args.listen, current.listen ?? null);
    const webhook = parseWebhook(args.webhook, args.webhookSecret, current.webhook);
    const webhookOnly = optionalBoolean(args.webhookOnly, "webhookOnly", current.webhookOnly);
    const effect = parseEffect(args.effect) ?? current.effect;
    const schedule = parseRoutineSchedule(
      args.schedule,
      new Date(),
      check || checkShell || listen ? 1 : 5,
    );
    const enabled = boolean(args.enabled, "enabled");
    const updated = this.store.updateRoutine(
      id,
      integer(args.expectedRevision),
      {
        title: requiredString(args.title, "title"),
        instruction: requiredString(args.instruction, "instruction"),
        check,
        checkShell,
        sites: optionalSites(args.sites, current.sites),
        listen,
        schedule,
        requiredBrowserInstanceId: optionalNullableUuid(
          args.requiredBrowserInstanceId,
          "requiredBrowserInstanceId",
          current.requiredBrowserInstanceId,
        ),
        webhook,
        webhookOnly,
        effect,
        enabled,
        nextDueAt: enabled ? nextRoutineOccurrence(schedule, new Date(), current.routineId) : null,
      },
      new Date().toISOString(),
    );
    if (current.chatId !== updated.chatId)
      throw new Error("Routine ownership changed unexpectedly.");
    return withWarning(updated);
  }

  private run(args: Record<string, unknown>, chatId: ChatId): unknown {
    const routine = this.requireOwned(requiredString(args.routineId, "routineId"), chatId);
    if (!routine.enabled) throw new Error("Enable this routine before running it manually.");
    return this.routines.runNow(routine.routineId);
  }

  private remove(args: Record<string, unknown>, chatId: ChatId): RoutineRecord {
    const routine = this.requireOwned(requiredString(args.routineId, "routineId"), chatId);
    return this.store.deleteRoutine(
      routine.routineId,
      integer(args.expectedRevision),
      new Date().toISOString(),
    );
  }

  private requireOwned(id: string, chatId: ChatId): RoutineRecord {
    const routine = this.store.getRoutine(id);
    if (!routine || routine.deletedAt || routine.chatId !== chatId)
      throw new Error("Routine does not exist in this Chat.");
    return routine;
  }
}

function previewSchedule(input: unknown): {
  schedule: ReturnType<typeof parseRoutineSchedule>;
  nextOccurrences: string[];
} {
  const now = new Date();
  const schedule = parseRoutineSchedule(input, now);
  const nextOccurrences: string[] = [];
  let cursor: Date | string = now;
  for (let index = 0; index < 3; index += 1) {
    const next = nextRoutineOccurrence(schedule, cursor);
    nextOccurrences.push(next);
    cursor = next;
  }
  return { schedule, nextOccurrences };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

/** Omitted keeps the current check (editors that do not know about checks); null removes it. */
function optionalCheck(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 8000)
    throw new Error("check must be browser code of at most 8000 characters, or null.");
  const undeclared = undeclaredAssignments(value);
  if (undeclared.length)
    throw new Error(
      `check assigns ${undeclared.map((name) => `\`${name}\``).join(", ")} without declaring it, ` +
        "so every run fails with a ReferenceError and the watcher never fires. Declare it " +
        `(\`let ${undeclared[0]} = false;\`; check variables persist between runs) or drop it.`,
    );
  return withListenDirective(value);
}

const DECLARED_KEYWORDS = /\b(?:let|const|var)\s+([^=;]+?)(?:=(?!=)|;|\bof\b|\bin\b|$)/gm;
const NAMED = /\b(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
// Arrow, function and catch parameters; `if (...) {` is not a parameter list.
const PARAMS =
  /\(([^()]*)\)\s*=>|\b(?:function\*?\s*[\w$]*|catch)\s*\(([^()]*)\)|([A-Za-z_$][\w$]*)\s*=>/g;
const ASSIGNED =
  /(?<![\w$.\]])\s*([A-Za-z_$][\w$]*)\s*(?:\+\+|--|(?:[-+*/%|&^]|\*\*|\?\?|\|\||&&)?=(?![=>]))/g;
const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * Names a check assigns (`seen = true`, `count++`) but never declares with let, const, var, a
 * function or a parameter. Reading such a name throws a ReferenceError before the first
 * assignment, so the check fails on every run and its watcher never fires.
 */
export function undeclaredAssignments(code: string): string[] {
  // Comments, strings and template text are not code.
  const plain = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  const declared = new Set<string>();
  const add = (text: string | undefined) => {
    for (const name of text?.match(IDENT) ?? []) declared.add(name);
  };
  for (const match of plain.matchAll(DECLARED_KEYWORDS)) add(match[1]);
  for (const match of plain.matchAll(NAMED)) add(match[1]);
  for (const match of plain.matchAll(PARAMS)) add(match[1] ?? match[2] ?? match[3]);
  const found = new Set<string>();
  for (const match of plain.matchAll(ASSIGNED)) {
    const name = match[1] ?? "";
    if (name && !declared.has(name) && !/^(?:globalThis|window|self|location)$/.test(name))
      found.add(name);
  }
  return [...found];
}

/**
 * The listen directive is a string statement, like "use strict". Written bare (`use listen;`) it
 * is a syntax error that fails every run, so the watcher never fires; quote it.
 */
export function withListenDirective(check: string): string {
  return check.replace(/^(\s*)use listen\b\s*;?/, '$1"use listen";');
}

/**
 * A one-time check runs once: if the moment is a little early or late it returns false and the
 * watcher never fires. Said back to the agent so it can switch to a poll or browser.snipe.
 */
export function onceCheckWarning(
  routine: Pick<RoutineRecord, "check" | "schedule">,
): string | null {
  if (routine.schedule.kind !== "once" || !routine.check) return null;
  if (/\bbrowser\.snipe\s*\(/.test(routine.check)) return null;
  return (
    "This check runs one time only: if the page is not ready at that instant it returns false " +
    "and the watcher never fires. For 'tell me when it opens/changes', use schedule " +
    "{kind: 'interval', everyMinutes: 1} (or listen) starting now, or browser.snipe for an exact moment."
  );
}

function withWarning(routine: RoutineRecord): RoutineRecord & { warning?: string } {
  const warning = onceCheckWarning(routine);
  return warning ? { ...routine, warning } : routine;
}

/** Omitted keeps the current list (editors that do not know about sites); an array replaces it. */
function optionalShellCheck(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 2000)
    throw new Error("checkShell must be a local command of at most 2000 characters, or null.");
  return value;
}

function optionalSites(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error("sites must be an array of site names.");
  return [...new Set(value.map((item) => optionalSite(item)))];
}

function optionalSite(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("sites must be site names such as example.com.");
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error("expectedRevision is invalid.");
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function optionalNullableUuid(
  value: unknown,
  label: string,
  fallback: string | null = null,
): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error(`${label} must be a browser client instance UUID or null.`);
  return value;
}
