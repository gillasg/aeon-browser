import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scrubSecrets } from "@graft/protocol";

// MCP Tasks (io.modelcontextprotocol/tasks): a long tool call or a watch runs as a durable task.
// working -> input_required (a confirmation or sign-in the agent must answer) -> completed,
// failed or cancelled. Every status change is pushed as notifications/tasks/status and saved,
// so tasks/get and tasks/result still answer after the server restarts.

type Json = Record<string, unknown>;
type Patch = { [K in keyof TaskRecord]?: TaskRecord[K] | undefined };
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const KEEP = 200;

export interface TaskRecord {
  taskId: string;
  name: string;
  status: TaskStatus;
  statusMessage?: string;
  inputRequest?: Json;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  result?: unknown;
  error?: string;
}

/** What a runner may do besides return: ask the agent, and notice a cancel. */
export interface TaskContext {
  signal: AbortSignal;
  ask: (request: { message: string; requestedSchema?: Json; kind?: string }) => Promise<Json>;
  /**
   * The call waits on the person in Chrome (a passkey, a code): input_required with no answer
   * needed; `resumed` moves the task back to working once the hand-off clears there.
   */
  parked: (message: string) => void;
  resumed: () => void;
}
export type TaskRunner = (name: string, args: Json, context: TaskContext) => Promise<unknown>;

interface Live {
  controller: AbortController;
  answer?: ((response: Json) => void) | undefined;
  done: Promise<void>;
}

export interface TaskManagerOptions {
  dataDirectory: string;
  notify: (method: string, params: Json) => void;
  run: TaskRunner;
}

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private readonly live = new Map<string, Live>();
  private loaded: Promise<void> | undefined;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TaskManagerOptions) {}

  async create(params: Json): Promise<Json> {
    await this.load();
    const name = String(params.name ?? "");
    if (!name) throw new Error("name is required");
    const args = (params.arguments as Json | undefined) ?? {};
    const now = new Date().toISOString();
    const ttl = Number((params.task as Json | undefined)?.ttl ?? params.ttl ?? 3_600_000);
    const task: TaskRecord = {
      taskId: randomUUID(),
      name,
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 3_600_000,
    };
    this.tasks.set(task.taskId, task);
    const controller = new AbortController();
    const live: Live = { controller, done: Promise.resolve() };
    this.live.set(task.taskId, live);
    this.changed(task);
    const created = view(task);
    live.done = this.drive(task, args, live);
    return { task: created };
  }

  async get(params: Json): Promise<Json> {
    return view(await this.find(params));
  }

  async list(): Promise<Json> {
    await this.load();
    return { tasks: [...this.tasks.values()].map(view) };
  }

  /** The answer to an input_required task; the task goes back to working. */
  async input(params: Json): Promise<Json> {
    const task = await this.find(params);
    const live = this.live.get(task.taskId);
    if (task.status !== "input_required" || !live?.answer)
      throw new Error(`Task ${task.taskId} is not waiting for input`);
    const answer = live.answer;
    live.answer = undefined;
    answer((params.response as Json | undefined) ?? {});
    return view(task);
  }

  async cancel(params: Json): Promise<Json> {
    const task = await this.find(params);
    if (TERMINAL.has(task.status)) throw new Error(`Task ${task.taskId} is already ${task.status}`);
    this.live.get(task.taskId)?.controller.abort();
    this.settle(task, { status: "cancelled", statusMessage: "Cancelled by the client." });
    return view(task);
  }

  /** Waits for a terminal status, then the result (or the failure as an error). */
  async result(params: Json): Promise<Json> {
    const task = await this.find(params);
    await this.live.get(task.taskId)?.done;
    const related = { _meta: { "io.modelcontextprotocol/related-task": { taskId: task.taskId } } };
    if (task.status === "completed") return { ...(task.result as Json), ...related };
    throw new Error(task.error ?? task.statusMessage ?? `Task ${task.taskId} is ${task.status}`);
  }

  close(): void {
    for (const live of this.live.values()) live.controller.abort();
  }

  private async drive(task: TaskRecord, args: Json, live: Live): Promise<void> {
    const context: TaskContext = {
      signal: live.controller.signal,
      ask: (request) => this.ask(task, live, request),
      parked: (message) =>
        this.update(task, {
          status: "input_required",
          statusMessage: message,
          inputRequest: { kind: "handoff", message },
        }),
      resumed: () => {
        if (task.status === "input_required" && !live.answer)
          this.update(task, {
            status: "working",
            statusMessage: undefined,
            inputRequest: undefined,
          });
      },
    };
    try {
      const result = await this.options.run(task.name, args, context);
      if (live.controller.signal.aborted) return;
      const failed = (result as Json | undefined)?.isError === true;
      this.settle(task, {
        status: failed ? "failed" : "completed",
        result: scrubSecrets(result),
        ...(failed ? { error: resultText(result) } : {}),
      });
    } catch (error) {
      if (live.controller.signal.aborted) return;
      const message = scrubSecrets(error instanceof Error ? error.message : String(error));
      this.settle(task, { status: "failed", error: message, statusMessage: message });
    } finally {
      this.live.delete(task.taskId);
    }
  }

  private ask(task: TaskRecord, live: Live, request: Parameters<TaskContext["ask"]>[0]) {
    return new Promise<Json>((resolve, reject) => {
      const signal = live.controller.signal;
      if (signal.aborted) return reject(new Error("cancelled"));
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      live.answer = (response) => {
        this.update(task, { status: "working", statusMessage: undefined, inputRequest: undefined });
        resolve(response);
      };
      this.update(task, {
        status: "input_required",
        statusMessage: request.message,
        inputRequest: scrubSecrets({ ...request }) as Json,
      });
    });
  }

  private settle(task: TaskRecord, patch: Patch): void {
    if (TERMINAL.has(task.status)) return;
    this.update(task, { inputRequest: undefined, ...patch });
  }

  private update(task: TaskRecord, patch: Patch): void {
    for (const [key, value] of Object.entries(patch))
      if (value === undefined) delete (task as unknown as Json)[key];
      else (task as unknown as Json)[key] = value;
    task.lastUpdatedAt = new Date().toISOString();
    this.changed(task);
  }

  private changed(task: TaskRecord): void {
    this.options.notify("notifications/tasks/status", view(task));
    this.saving = this.saving.then(() => this.save()).catch(() => undefined);
  }

  private async find(params: Json): Promise<TaskRecord> {
    await this.load();
    const task = this.tasks.get(String(params.taskId ?? ""));
    if (!task) throw new Error(`Unknown taskId ${String(params.taskId)}`);
    return task;
  }

  private path(): string {
    return join(this.options.dataDirectory, "mcp-tasks.json");
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await readFile(this.path(), "utf8").catch(() => "[]");
      for (const task of parseSaved(text)) {
        // A task that was mid-run when its server stopped cannot continue.
        if (!TERMINAL.has(task.status))
          Object.assign(task, { status: "failed", error: "The MCP server restarted." });
        delete task.inputRequest;
        if (!this.tasks.has(task.taskId)) this.tasks.set(task.taskId, task);
      }
    })();
    return this.loaded;
  }

  private async save(): Promise<void> {
    await this.load();
    const now = Date.now();
    const kept = [...this.tasks.values()]
      .filter((task) => !TERMINAL.has(task.status) || now - Date.parse(task.createdAt) < task.ttl)
      .slice(-KEEP);
    this.tasks = new Map(kept.map((task) => [task.taskId, task]));
    await mkdir(this.options.dataDirectory, { recursive: true });
    const path = this.path();
    await writeFile(`${path}.tmp`, JSON.stringify(kept));
    await rename(`${path}.tmp`, path);
  }
}

function parseSaved(text: string): TaskRecord[] {
  try {
    const saved = JSON.parse(text) as unknown;
    return Array.isArray(saved) ? (saved as TaskRecord[]) : [];
  } catch {
    return [];
  }
}

/** The task as the client sees it: status, never the stored result or raw error. */
function view(task: TaskRecord): Json {
  const out: Json = { ...task };
  delete out.result;
  delete out.error;
  if (task.error) out.statusMessage = task.statusMessage ?? task.error;
  return out;
}

function resultText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] } | undefined)?.content ?? [];
  return content.map((part) => part.text ?? "").join("") || "The tool call failed.";
}
