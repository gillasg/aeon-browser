import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dropActRoute, readActRoute, saveActRoute, type ModelLike } from "@browserkit/site-mapper";

// page.observe / page.act in browser code: one small-model call picks elements on the page for a
// plain-language instruction, and a local cache replays a step that worked before without any
// model call. The cell sends the page as compact lines (`[id] role "name"`), never variable
// values: the model sees `%name%` placeholders only, and the cache stores the placeholders.

export const LOCATE_METHODS = [
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
] as const;
export type LocateMethod = (typeof LOCATE_METHODS)[number];

export interface LocatedAction {
  id: string;
  method: LocateMethod;
  args: string[];
  description: string;
}

export interface LocateAnswer {
  actions: LocatedAction[];
  /** The first action only opens something (a menu, a dialog): look again for the second. */
  twoStep: boolean;
}

interface LocateRequest {
  locate: {
    instruction?: unknown;
    url?: unknown;
    page?: unknown;
    variables?: unknown;
    limit?: unknown;
    /** "observe": up to `limit` actions; "act": the one action; "second": finish an act. */
    mode?: unknown;
    /** The step already taken, for the second look of a two-step act. */
    done?: unknown;
  };
}

export function isLocateRequest(value: unknown): value is LocateRequest {
  const locate = (value as { locate?: unknown } | null)?.locate;
  return Boolean(locate && typeof locate === "object");
}

const MAX_PAGE = 24_000;

const SYSTEM = [
  "You pick elements on a web page for a browser agent. The page is given as lines:",
  '`[id] role "name"` (with `= value` and states for fields), `## heading` and plain text.',
  "Answer only by calling `choose`. Use ids exactly as shown; never invent one.",
  "Methods: click; fill (args: [text]); press (args: [key], e.g. Enter); select (args: [option label]);",
  "check; uncheck; hover. Where a value is given as a variable, put `%name%` in args, never a guess.",
  "Prefer the most specific element (the field itself, not its label; the button, not its container).",
  "When nothing on the page fits, return no actions.",
].join("\n");

const CHOOSE_TOOL = {
  name: "choose",
  description: "The elements and what to do with each, best first.",
  parameters: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            method: { type: "string", enum: [...LOCATE_METHODS] },
            args: { type: "array", items: { type: "string" } },
            description: { type: "string", description: "Short: what the element is." },
          },
          required: ["id", "method", "args", "description"],
          additionalProperties: false,
        },
      },
      twoStep: {
        type: "boolean",
        description:
          "True when the first action only opens a menu, dropdown or dialog and the instruction needs a second choice in it.",
      },
    },
    required: ["actions", "twoStep"],
    additionalProperties: false,
  },
};

function text(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((name) => text(name, 60)).filter(Boolean) : [];
}

export function locatePrompt(request: LocateRequest["locate"]): string {
  const mode =
    request.mode === "observe" ? "observe" : request.mode === "second" ? "second" : "act";
  const limit = Math.min(Math.max(Number(request.limit) || 1, 1), 30);
  const variables = names(request.variables);
  const task =
    mode === "observe"
      ? `Find up to ${limit} elements for: ${text(request.instruction, 2000)}`
      : mode === "second"
        ? `Already done: ${text(request.done, 500)}. Now pick the one action that finishes: ${text(request.instruction, 2000)}. Only the part of the page that changed is shown.`
        : `Pick the one action that does: ${text(request.instruction, 2000)}`;
  return [
    task,
    variables.length ? `Variables: ${variables.map((name) => `%${name}%`).join(", ")}` : "",
    `Page ${text(request.url, 500)}:`,
    text(request.page, MAX_PAGE),
  ]
    .filter(Boolean)
    .join("\n\n");
}

type ToolCall = { type: "toolCall"; name: string; arguments: Record<string, unknown> };

function choice(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  const call = content.find(
    (part): part is ToolCall =>
      Boolean(part) &&
      (part as ToolCall).type === "toolCall" &&
      (part as ToolCall).name === "choose",
  );
  return call?.arguments;
}

function action(value: unknown): LocatedAction | undefined {
  const item = value as Record<string, unknown> | null;
  const method = String(item?.method ?? "") as LocateMethod;
  const id = text(item?.id, 40).replace(/^\[|\]$/g, "");
  if (!id || !LOCATE_METHODS.includes(method)) return undefined;
  return {
    id,
    method,
    args: Array.isArray(item?.args) ? item.args.map((arg) => String(arg).slice(0, 2000)) : [],
    description: text(item?.description, 200),
  };
}

/** One model call: the actions it chose, at most `limit` (one for an act). */
export async function answerLocate(
  request: LocateRequest,
  model: (() => Promise<ModelLike | undefined>) | undefined,
): Promise<LocateAnswer> {
  const chosen = await model?.();
  if (!chosen)
    throw new Error(
      "NEEDS_MODEL: page.observe and page.act need a model and this host has none; use bu.state() and act by id",
    );
  const reply = await chosen.complete({
    systemPrompt: SYSTEM,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: locatePrompt(request.locate) }],
        timestamp: Date.now(),
      },
    ],
    tools: [CHOOSE_TOOL],
  });
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    throw new Error(`MODEL_FAILED: ${String(reply.errorMessage ?? "the model failed")}`);
  const picked = choice(reply.content);
  const limit = request.locate.mode === "observe" ? Number(request.locate.limit) || 8 : 1;
  const actions = (Array.isArray(picked?.actions) ? picked.actions : [])
    .map(action)
    .filter((item): item is LocatedAction => Boolean(item))
    .slice(0, Math.min(Math.max(limit, 1), 30));
  const acting = request.locate.mode !== "observe" && request.locate.mode !== "second";
  return { actions, twoStep: acting && picked?.twoStep === true };
}

// ---------- page.extract(instruction, {schema}) ----------

interface PageExtractRequest {
  pageExtract: { instruction?: unknown; schema?: unknown; url?: unknown; page?: unknown };
}

export function isPageExtractRequest(value: unknown): value is PageExtractRequest {
  const extract = (value as { pageExtract?: unknown } | null)?.pageExtract;
  return Boolean(extract && typeof extract === "object");
}

const EXTRACT_SYSTEM = [
  "You read a web page for a browser agent and answer only by calling `answer`.",
  "Use only what the page says; a value the page does not show is null, never a guess.",
  "Copy numbers, prices and dates exactly as shown.",
].join("\n");

function extractSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const given = schema as Record<string, unknown>;
    if (given.type === "object") return given;
    return { type: "object", properties: { value: given }, required: ["value"] };
  }
  return {
    type: "object",
    properties: { value: { description: "The answer: a string, number, object or list." } },
    required: ["value"],
  };
}

/** One fast-model call over the page's text, shaped by the caller's JSON schema. */
export async function answerPageExtract(
  request: PageExtractRequest,
  model: (() => Promise<ModelLike | undefined>) | undefined,
): Promise<unknown> {
  const chosen = await model?.();
  if (!chosen)
    throw new Error(
      "NEEDS_MODEL: page.extract(instruction) needs a model and this host has none; use page.read()",
    );
  const given = request.pageExtract;
  const parameters = extractSchema(given.schema);
  const reply = await chosen.complete({
    systemPrompt: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${text(given.instruction, 2000)}

Page ${text(given.url, 500)}:

${text(given.page, 60_000)}`,
          },
        ],
        timestamp: Date.now(),
      },
    ],
    tools: [{ name: "answer", description: "The data asked for.", parameters }],
  });
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    throw new Error(`MODEL_FAILED: ${String(reply.errorMessage ?? "the model failed")}`);
  const content = Array.isArray(reply.content) ? reply.content : [];
  const call = content.find(
    (part): part is ToolCall =>
      Boolean(part) &&
      (part as ToolCall).type === "toolCall" &&
      (part as ToolCall).name === "answer",
  );
  if (!call) throw new Error("MODEL_FAILED: the model gave no answer");
  const wrapped = !(given.schema && (given.schema as { type?: unknown }).type === "object");
  return wrapped ? (call.arguments.value ?? null) : call.arguments;
}

// ---------- the action cache ----------

/** A step as replayed: the element by role and name (ids change every load), never a value. */
export interface CachedStep {
  role: string;
  name: string;
  method: LocateMethod;
  args: string[];
  description: string;
}

interface CacheEntry {
  steps: CachedStep[];
  savedAt: number;
  hits: number;
}

interface ActionCacheRequest {
  actionCache: "get" | "put" | "drop";
  site?: unknown;
  instruction?: unknown;
  variables?: unknown;
  steps?: unknown;
}

export function isActionCacheRequest(value: unknown): value is ActionCacheRequest {
  const kind = (value as { actionCache?: unknown } | null)?.actionCache;
  return kind === "get" || kind === "put" || kind === "drop";
}

export function isActRouteRequest(value: unknown): value is ActionCacheRequest {
  const kind = (value as { actRoute?: unknown } | null)?.actRoute;
  if (kind !== "get" && kind !== "put" && kind !== "drop") return false;
  const body = value as { actionCache?: unknown };
  body.actionCache = kind;
  return true;
}

const MAX_ENTRIES = 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const writes = new Map<string, Promise<unknown>>();

export const actionCachePath = (home: string): string => join(home, "action-cache.json");

/** One key per site, instruction (case and spacing ignored) and set of variable names. */
export function actionCacheKey(site: unknown, instruction: unknown, variables: unknown): string {
  const host = text(site, 200)
    .toLowerCase()
    .replace(/^www\./, "");
  const said = text(instruction, 2000).toLowerCase().replace(/\s+/g, " ");
  return [host, said, names(variables).sort().join(",")].join("\u0000");
}

async function readCache(home: string): Promise<Record<string, CacheEntry>> {
  try {
    const parsed = JSON.parse(await readFile(actionCachePath(home), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

async function writeCache(home: string, entries: Record<string, CacheEntry>): Promise<void> {
  const kept = Object.entries(entries)
    .filter(([, entry]) => Date.now() - entry.savedAt < MAX_AGE_MS)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_ENTRIES);
  await mkdir(home, { recursive: true });
  const file = actionCachePath(home);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(Object.fromEntries(kept)), "utf8");
  await rename(temporary, file);
}

function cachedStep(value: unknown): CachedStep | undefined {
  const item = value as Record<string, unknown> | null;
  const method = String(item?.method ?? "") as LocateMethod;
  if (!item || !LOCATE_METHODS.includes(method) || typeof item.role !== "string") return undefined;
  return {
    role: text(item.role, 60),
    name: text(item.name, 300),
    method,
    // Only placeholders and words from the instruction: a value the cell substituted is never sent.
    args: Array.isArray(item.args) ? item.args.map((arg) => String(arg).slice(0, 500)) : [],
    description: text(item.description, 200),
  };
}

/** Serialised per file, so two cells finishing at once do not lose an entry. */
function serialised<T>(home: string, work: () => Promise<T>): Promise<T> {
  const prior = writes.get(home) ?? Promise.resolve();
  const next = prior.then(work, work);
  writes.set(
    home,
    next.catch(() => undefined),
  );
  return next;
}

export function handleActionCache(request: ActionCacheRequest, home: string): Promise<unknown> {
  const key = actionCacheKey(request.site, request.instruction, request.variables);
  if (request.actionCache === "get") return readCached(home, key);
  return serialised(home, async () => {
    const entries = await readCache(home);
    if (request.actionCache === "drop") return dropCached(home, key, entries);
    const steps = (Array.isArray(request.steps) ? request.steps : [])
      .map(cachedStep)
      .filter((step): step is CachedStep => Boolean(step))
      .slice(0, 4);
    if (!steps.length) return { saved: false };
    entries[key] = { steps, savedAt: Date.now(), hits: (entries[key]?.hits ?? 0) + 1 };
    await writeCache(home, entries);
    await saveActRoute(
      home,
      key,
      text(request.site, 200),
      text(request.instruction, 200),
      steps,
    ).catch(() => undefined);
    return { saved: true };
  });
}

async function readCached(home: string, key: string): Promise<{ steps: CachedStep[] | null }> {
  const entries = await readCache(home);
  if (entries[key]?.steps) return { steps: entries[key].steps };
  const routed = await readActRoute(home, key).catch(() => undefined);
  if (!routed) return { steps: null };
  return {
    steps: routed.steps.map((step) => ({
      role: step.role,
      name: step.name,
      method: step.method as LocateMethod,
      args: step.args,
      description: step.description,
    })),
  };
}

async function dropCached(
  home: string,
  key: string,
  entries: Record<string, CacheEntry>,
): Promise<{ dropped: boolean }> {
  const dropped = key in entries;
  delete entries[key];
  if (dropped) await writeCache(home, entries);
  const routed = await dropActRoute(home, key).catch(() => false);
  return { dropped: dropped || routed };
}
