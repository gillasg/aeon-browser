import {
  loadModel,
  operationDeclaration,
  generateStandaloneClient,
  searchCatalog,
} from "@browserkit/tools/site-to-api";
import type { AeonClient } from "./client.js";
import { callCatalogResult, type CatalogTool } from "./catalog.js";
import { answer, questions } from "./converse.js";
import type { TaskContext } from "./mcp-tasks.js";
import {
  HANDOFF_TABS_CODE,
  errorResult,
  pollHandoff,
  runParkableCell,
  type ParkingLot,
} from "./mcp-code-mode.js";
import type { Run } from "./mcp.js";

// The handlers behind the five code-surface tools.

type Json = Record<string, unknown>;
const RUN_HANDLE = "h_run_";
const HANDOFF_SESSION = "mcp-handoff-watch";

export interface CodeToolDeps {
  aeon: () => Promise<AeonClient>;
  parking: ParkingLot;
  catalog: () => readonly CatalogTool[];
  /** Resolves once the first catalog load has finished (or a bounded wait ran out). */
  catalogReady?: () => Promise<void>;
  session: string;
  runs: Map<string, Run>;
  startRun: (args: Json) => Promise<{ runId: string }>;
  callChat: (name: string, args: Json, signal?: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  context?: TaskContext;
}

function text(value: unknown): Json {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    isError: false,
  };
}

export async function codeSurfaceCall(
  name: string,
  args: Json,
  deps: CodeToolDeps,
): Promise<unknown> {
  try {
    if (name === "browser_code") return await browserCode(args, deps);
    if (name === "aeon_find") return text(await find(args, deps));
    if (name === "aeon_call") return await call(args, deps);
    if (name === "aeon_resume") return await resume(args, deps);
    if (name === "aeon_run") return await run(args, deps);
    return errorResult(new Error(`Unknown tool ${name}`));
  } catch (error) {
    return errorResult(error);
  }
}

function browserCode(args: Json, deps: CodeToolDeps): Promise<unknown> {
  const listTabs = async () =>
    (
      await (
        await deps.aeon()
      ).browserRun({
        code: HANDOFF_TABS_CODE,
        session: HANDOFF_SESSION,
        timeoutMs: 5000,
      })
    )?.value;
  const context = deps.context;
  // Only a hand-off that starts while this cell runs can be this cell's.
  const since = Date.now();
  return runParkableCell(
    deps.parking,
    {
      run: (signal) => deps.callChat("browser_code", args, signal),
      watchHandoff: (signal) => pollHandoff(listTabs, signal, { since }),
      watchCleared: async (signal) => {
        await pollHandoff(listTabs, signal, { cleared: true, since });
      },
    },
    {
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(context
        ? {
            onPause: (message: string) => context.parked(message),
            onResume: () => context.resumed(),
          }
        : {}),
    },
  );
}

/** `<site>/<id>` or the catalog's own `site__…` name. */
function findTool(tools: readonly CatalogTool[], ref: string): CatalogTool | undefined {
  return tools.find((tool) => tool.name === ref || `${tool.site}/${tool.id}` === ref);
}

async function find(args: Json, deps: CodeToolDeps): Promise<unknown> {
  await deps.catalogReady?.();
  const tools = deps.catalog();
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  if (ref.startsWith("site:")) {
    const model = await loadModel(ref.slice(5));
    if (!model) throw new Error(`${ref.slice(5)} is not mapped. Learn it: aeon compile <url>`);
    return generateStandaloneClient(model).declarations;
  }
  if (ref) {
    const tool = findTool(tools, ref);
    if (!tool) throw new Error(`Unknown ref ${ref}; search with aeon_find {query}`);
    const model = tool.kind === "operation" ? await loadModel(tool.site) : undefined;
    const signature = model ? operationDeclaration(model, tool.id) : undefined;
    return {
      ref: `${tool.site}/${tool.id}`,
      effect: tool.effect,
      dts:
        signature ??
        `declare function ${tool.id}(params: ${JSON.stringify(tool.inputSchema)}): Promise<unknown>;`,
      example: { tool: "aeon_call", arguments: { ref: `${tool.site}/${tool.id}`, params: {} } },
    };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("Pass {query} or {ref}");
  return searchCatalog([...tools], query)
    .slice(0, 8)
    .map((tool) => `${tool.site}/${tool.id} · ${tool.effect} · ${tool.description.split("\n")[0]}`);
}

async function call(args: Json, deps: CodeToolDeps): Promise<unknown> {
  await deps.catalogReady?.();
  const ref = String(args.ref ?? "");
  const tool = findTool(deps.catalog(), ref);
  const params = (args.params as Json | undefined) ?? {};
  // The same result as the site tool itself, structuredContent included.
  return callCatalogResult(tool?.name ?? ref, params, deps.catalog());
}

async function run(args: Json, deps: CodeToolDeps): Promise<unknown> {
  const { runId } = await deps.startRun({
    tasks: [String(args.task ?? "")],
    ...(typeof args.model === "string" ? { model: args.model } : {}),
    ...(args.quiet === true ? { quiet: true } : {}),
  });
  return text({ status: "working", handle: `${RUN_HANDLE}${runId}`, resumeWith: "aeon_resume" });
}

async function resume(args: Json, deps: CodeToolDeps): Promise<unknown> {
  const handle = String(args.handle ?? "");
  const waitMs = Math.min(50, Math.max(0, Number(args.waitSeconds ?? 25))) * 1000;
  if (handle.startsWith(RUN_HANDLE)) return resumeRun(handle, args, waitMs, deps);
  if (typeof args.reply === "string" && deps.parking.has(handle))
    return errorResult(new Error("A paused cell waits on the person in Chrome, not a reply."));
  return deps.parking.resume(handle, waitMs);
}

/** A finished run's answer and stats, without its trace. */
function runDone(record: Run): Json {
  const result: Json = { ...(record.results?.[0] ?? {}) };
  delete result.trace;
  return text({ status: "done", value: result.answer, result });
}

async function resumeRun(
  handle: string,
  args: Json,
  waitMs: number,
  deps: CodeToolDeps,
): Promise<unknown> {
  const record = deps.runs.get(handle.slice(RUN_HANDLE.length));
  if (!record) throw new Error(`Unknown handle ${handle}`);
  const client = await deps.aeon();
  const chatId = record.chats[0];
  if (typeof args.reply === "string" && chatId) await answer(client, chatId, args.reply);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (record.results) return runDone(record);
    if (record.error) return errorResult(new Error(record.error));
    const asked = chatId ? await questions(client, chatId).catch(() => []) : [];
    if (asked.length)
      return text({ status: "paused", handle, questions: asked, resumeWith: "aeon_resume" });
    if (Date.now() >= deadline)
      return text({ status: "working", handle, chatId, resumeWith: "aeon_resume" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
