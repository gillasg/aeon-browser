import { aeonDataDirectory } from "@aeon/location";
import { EVENTS_EXTENSION, EventHub, nextEvent } from "./mcp-events.js";
import { TASKS_EXTENSION, TaskManager, type TaskContext } from "./mcp-tasks.js";
import type { CatalogTool } from "./catalog.js";

// The events/* and tasks/* methods of `aeon mcp`, and the task runner behind them.

type Json = Record<string, unknown>;
export type CallTool = (name: string, args: Json, signal: AbortSignal) => Promise<unknown>;
export const WATCH_TASK = "aeon_watch";

export interface McpExtensions {
  events: EventHub;
  tasks: TaskManager;
  close: () => void;
}

export function createExtensions(
  notify: (method: string, params: Json) => void,
  callTool: CallTool,
  catalog: () => readonly CatalogTool[],
): McpExtensions {
  const dataDirectory = aeonDataDirectory();
  const pollMs = Number(process.env.AEON_EVENTS_POLL_MS ?? 1000);
  const events = new EventHub({
    dataDirectory,
    notify,
    pollMs: Number.isFinite(pollMs) && pollMs >= 20 ? pollMs : 1000,
  });
  const tasks = new TaskManager({
    dataDirectory,
    notify,
    run: (name, args, context) => runTask(name, args, context, { events, callTool, catalog }),
  });
  return {
    events,
    tasks,
    close: () => {
      events.stop();
      tasks.close();
    },
  };
}

export function extensionCapabilities(): Json {
  return {
    tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    extensions: { [EVENTS_EXTENSION]: {}, [TASKS_EXTENSION]: {} },
  };
}

/** An events/* or tasks/* request; undefined when the method is neither. */
export function handleExtension(
  extensions: McpExtensions,
  method: string,
  params: Json,
): Promise<Json> | undefined {
  const { events, tasks } = extensions;
  const table: Record<string, () => Json | Promise<Json>> = {
    "events/list": () => events.list(),
    "events/subscribe": () => events.subscribe(params),
    "events/unsubscribe": () => events.unsubscribe(params),
    "events/poll": () => events.poll(params),
    "tasks/create": () => tasks.create(params),
    "tasks/get": () => tasks.get(params),
    "tasks/list": () => tasks.list(),
    "tasks/input": () => tasks.input(params),
    "tasks/cancel": () => tasks.cancel(params),
    "tasks/result": () => tasks.result(params),
  };
  const run = table[method];
  return run ? Promise.resolve().then(run) : undefined;
}

/** A task-augmented tools/call (params.task set) becomes a task instead of a result. */
export function taskAugmentedCall(
  extensions: McpExtensions,
  params: Json,
): Promise<Json> | undefined {
  if (!params.task || typeof params.task !== "object") return undefined;
  return extensions.tasks.create({
    name: params.name,
    arguments: params.arguments,
    task: params.task,
  });
}

interface RunDeps {
  events: EventHub;
  callTool: CallTool;
  catalog: () => readonly CatalogTool[];
}

async function runTask(name: string, args: Json, context: TaskContext, deps: RunDeps) {
  if (name === WATCH_TASK) {
    const event = await nextEvent(deps.events, args, context.signal);
    if (!event) throw new Error("cancelled");
    return { content: [{ type: "text", text: JSON.stringify(event) }], structuredContent: event };
  }
  const tool = deps.catalog().find((item) => item.name === name);
  if (tool?.effect === "irreversible") await confirm(tool, args, context);
  const result = await deps.callTool(name, args, context.signal);
  if (needsSignIn(result)) {
    await context.ask({ kind: "sign_in", message: `Sign in for ${name}, then answer to retry.` });
    return deps.callTool(name, args, context.signal);
  }
  return result;
}

/** The cliff edge: an irreversible call waits for the agent (or its human) to say yes. */
async function confirm(tool: CatalogTool, args: Json, context: TaskContext): Promise<void> {
  const answer = await context.ask({
    kind: "confirm",
    message: `${tool.name} is irreversible. Confirm to run it with these arguments.`,
    requestedSchema: {
      type: "object",
      properties: { confirm: { type: "boolean" }, arguments: { const: args } },
      required: ["confirm"],
    },
  });
  if (answer.confirm !== true) throw new Error("Declined: the irreversible call was not run.");
}

function needsSignIn(result: unknown): boolean {
  const value = result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  if (value?.isError !== true) return false;
  const text = (value.content ?? []).map((part) => part.text ?? "").join(" ");
  return /\b(sign[- ]?in|log[- ]?in|401|unauthori[sz]ed)\b/i.test(text);
}
