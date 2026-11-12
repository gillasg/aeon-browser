import { join } from "node:path";
import {
  InMemoryModelsStore,
  createModels,
  isModelType,
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
  type ModelsStore,
  type MutableModels,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Pi keeps its own model list current by refreshing provider catalogs into a file-backed
// ModelsStore and merging the result over the built-in catalog. Aeon reuses the same machinery:
// a background Models.refresh(), the same store format, and one provider wrapper for the live
// list OpenCode Go serves, which no shipped catalog covers on release day.

/** Aeon's catalog cache, beside Pi's own `models-store.json` in the shared agent directory. */
export const LIVE_MODELS_STORE_FILE = "aeon-models-store.json";

/** OpenCode Go's own list, the one its app and site show. */
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

/** A successful list is trusted for an hour; OpenCode adds models without a package release. */
export const LIVE_MODELS_REFRESH_MS = 60 * 60 * 1000;

/** Pi's remote catalog is checked every four hours; keep the same background rhythm. */
const BACKGROUND_REFRESH_MS = 4 * 60 * 60 * 1000;

/** The agent directory's cache file. ModelRuntime and LoginService both write it. */
export function aeonModelsStorePath(agentDirectory: string): string {
  return join(agentDirectory, LIVE_MODELS_STORE_FILE);
}

export interface AeonModelRuntimeOptions {
  /** Pi's agent directory (`~/.pi/agent` by default). */
  agentDirectory?: string;
  /** Test seam: replaces the on-disk store. */
  modelsStore?: ModelsStore;
  /** Test seam: replaces `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A `ModelRuntime` with every provider Pi ships, plus OpenCode Go's live list. Restores the
 * cache; callers schedule `refreshInBackground` when they show a model list.
 */
export async function createAeonModelRuntime(
  options: AeonModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const agentDirectory = options.agentDirectory;
  const runtime = await ModelRuntime.create({
    ...(agentDirectory
      ? {
          authPath: join(agentDirectory, "auth.json"),
          modelsPath: join(agentDirectory, "models.json"),
          modelsStorePath: aeonModelsStorePath(agentDirectory),
        }
      : {}),
    ...(options.modelsStore ? { modelsStore: options.modelsStore } : {}),
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider("opencode-go");
  if (provider)
    runtime.registerNativeProvider(withLiveModelList(provider, opencodeGoSource(options.fetch)));
  return runtime;
}

/**
 * A plain `Models` collection with the same wrappers, for callers that do not need Pi's
 * models.json composition (tests, and the code paths that only read a catalog).
 */
export function createLiveModels(options: {
  credentials: CredentialStore;
  modelsStore?: ModelsStore;
  fetch?: typeof fetch;
}): { models: MutableModels; refresh(signal?: AbortSignal): Promise<void> } {
  const models = createModels({
    credentials: options.credentials,
    modelsStore: options.modelsStore ?? new InMemoryModelsStore(),
  });
  for (const provider of builtinProviders())
    models.setProvider(
      provider.id === "opencode-go"
        ? withLiveModelList(provider, opencodeGoSource(options.fetch))
        : provider,
    );
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    // Catalog failures fall back to the cache, then to the built-in list. They are never
    // surfaced: a stale list is not an error the user can act on.
    await models.refresh(signal ? { signal } : {}).catch(() => undefined);
  };
  return { models, refresh };
}

const backgroundRefreshes = new Map<string, { at: number; running: Promise<void> }>();

/**
 * Fetches newer catalogs without blocking the caller. One refresh per store at a time, and no
 * more than once per Pi interval; failures stay quiet.
 */
export function refreshInBackground(models: Models, key: string): void {
  const existing = backgroundRefreshes.get(key);
  if (existing?.running) return;
  if (existing && Date.now() - existing.at < BACKGROUND_REFRESH_MS) return;
  const running = models
    .refresh({ allowNetwork: true })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      const entry = backgroundRefreshes.get(key);
      if (entry?.running === running) backgroundRefreshes.delete(key);
    });
  backgroundRefreshes.set(key, { at: Date.now(), running });
}

/** What a provider's live list needs: the resolved credential and a signal. */
export interface LiveModelSource {
  /** How long a fetched list is trusted before another network request. */
  freshForMs: number;
  fetch(credential: Credential, signal: AbortSignal): Promise<readonly Model<Api>[]>;
}

/**
 * Adds a live list over a provider's built-in catalog. Built-in entries always win; the live
 * list only contributes model ids the package does not know yet. The live-only models are
 * persisted in the provider's ModelsStore entry, so an offline start still sees them.
 */
export function withLiveModelList(provider: Provider, source: LiveModelSource): Provider {
  let liveOnly: readonly Model<Api>[] = [];
  const base = () => provider.getAllModels?.() ?? provider.getModels();
  return {
    ...provider,
    // The live list needs the resolved key, not just "is the provider configured".
    refreshModelsAuth: "credential",
    getModels: () => mergeModels(provider.getModels(), liveOnly, provider.id),
    getAllModels: () => mergeModels(base(), liveOnly, provider.id),
    refreshModels: async (context: RefreshModelsContext) => {
      const known = new Set(base().map((model) => `${model.provider}\0${model.id}`));
      const restored = (context.stored?.models ?? [])
        .filter((model) => isModelType(model, "chat"))
        .filter(
          (model) => model.provider === provider.id && !known.has(`${model.provider}\0${model.id}`),
        );
      if (!(await context.publish({ update: () => void (liveOnly = restored) }))) return;
      if (!context.allowNetwork || context.signal.aborted) return;
      if (!context.force && isFresh(context, source.freshForMs)) return;
      if (!context.credential) return;
      const fetched = await source.fetch(context.credential, context.signal);
      if (context.signal.aborted) return;
      const unknown = mergeModels(provider.getModels(), fetched, provider.id).filter(
        (model) => !known.has(`${model.provider}\0${model.id}`),
      );
      const checkedAt = Date.now();
      await context.publish({
        persist: { models: unknown, checkedAt, lastModified: checkedAt },
        update: () => void (liveOnly = unknown),
      });
    },
  };
}

function isFresh(context: RefreshModelsContext, freshForMs: number): boolean {
  const checkedAt = context.stored?.checkedAt;
  return typeof checkedAt === "number" && Date.now() - checkedAt < freshForMs;
}

/** The built-in catalog wins by id; live entries fill in what it does not have. */
function mergeModels<T extends { provider: string; id: string }>(
  builtin: readonly T[],
  live: readonly { provider: string; id: string }[],
  providerId: string,
): T[] {
  const merged = [...builtin];
  const ids = new Set(builtin.map((model) => `${model.provider}\0${model.id}`));
  for (const model of live) {
    if (model.provider !== providerId) continue;
    const key = `${model.provider}\0${model.id}`;
    if (ids.has(key)) continue;
    ids.add(key);
    merged.push(model as T);
  }
  return merged;
}

function opencodeGoSource(fetchImpl: typeof fetch = fetch): LiveModelSource {
  return {
    freshForMs: LIVE_MODELS_REFRESH_MS,
    fetch: async (credential, signal) => {
      const key = credential.type === "api_key" ? credential.key : credential.access;
      if (!key) return [];
      const response = await fetchImpl(OPENCODE_GO_MODELS_URL, {
        headers: { accept: "application/json", authorization: `Bearer ${key}` },
        signal,
      });
      // Never include request headers or the response body: both can carry the key.
      if (!response.ok) throw new Error(`OpenCode Go model list: HTTP ${response.status}`);
      return readOpenCodeGoModels(await response.json()).map((model) => ({
        ...model,
        provider: "opencode-go",
      }));
    },
  };
}

const API_KEYS: Record<string, Api> = {
  "chat-completions": "openai-completions",
  responses: "openai-responses",
  messages: "anthropic-messages",
  "generate-content": "google-generative-ai",
};

/**
 * Reads OpenCode Go's `/v1/models` payload. Only fields the list actually carries are used:
 * missing limits and prices stay 0 ("unknown") instead of a plausible-looking guess.
 */
export function readOpenCodeGoModels(body: unknown): Model<Api>[] {
  const entries = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : [];
  const templates = new Map<Api, Model<Api>>();
  for (const template of builtinTemplates())
    if (!templates.has(template.api)) templates.set(template.api, template);
  const models: Model<Api>[] = [];
  for (const entry of entries) {
    const model = readEntry(entry, templates);
    if (model) models.push(model);
  }
  return models;
}

function builtinTemplates(): readonly Model<Api>[] {
  return (
    builtinProviders()
      .find((provider) => provider.id === "opencode-go")
      ?.getModels() ?? []
  );
}

function readEntry(
  entry: unknown,
  templates: ReadonlyMap<Api, Model<Api>>,
): Model<Api> | undefined {
  if (!isRecord(entry) || !isChatEntry(entry)) return undefined;
  const id = entryId(entry);
  if (!id) return undefined;
  const api = apiOf(entry, templates);
  const template = api ? templates.get(api) : undefined;
  if (!api || !template) return undefined;
  return buildModel(entry, id, api, template);
}

function buildModel(
  entry: Record<string, unknown>,
  id: string,
  api: Api,
  template: Model<Api>,
): Model<Api> {
  const input = inputModalities(entry);
  const model: Model<Api> = {
    id,
    name: entryName(entry, id),
    api,
    provider: "opencode-go",
    baseUrl: template.baseUrl,
    input,
    cost: costOf(entry),
    contextWindow: numberAt(entry.limit, "context"),
    maxTokens: numberAt(entry.limit, "output"),
    reasoning: isReasoning(entry),
    type: "chat",
  } as Model<Api>;
  if (template.compat !== undefined) model.compat = template.compat;
  if (input.includes("image") && template.inputLimits) model.inputLimits = template.inputLimits;
  const thinking = thinkingLevelMap(entry);
  if (thinking) model.thinkingLevelMap = thinking;
  return model;
}

function isChatEntry(entry: Record<string, unknown>): boolean {
  return entry.type === undefined || entry.type === "chat";
}

function entryId(entry: Record<string, unknown>): string {
  return typeof entry.id === "string" ? entry.id.trim() : "";
}

function entryName(entry: Record<string, unknown>, id: string): string {
  return (typeof entry.name === "string" ? entry.name.trim() : "") || id;
}

function isReasoning(entry: Record<string, unknown>): boolean {
  const capabilities = entry.capabilities;
  if (!isRecord(capabilities) || !isRecord(capabilities.reasoning)) return false;
  return capabilities.reasoning.supported === true;
}

function apiOf(
  entry: Record<string, unknown>,
  templates: ReadonlyMap<Api, Model<Api>>,
): Api | undefined {
  if (!isRecord(entry.api)) return undefined;
  for (const name of Object.keys(entry.api)) {
    const api = API_KEYS[name];
    if (api && templates.has(api)) return api;
  }
  return undefined;
}

function inputModalities(entry: Record<string, unknown>): ("text" | "image")[] {
  const list =
    isRecord(entry.modalities) && Array.isArray(entry.modalities.input)
      ? entry.modalities.input
      : [];
  const hasImage = list.some((value) => typeof value === "string" && value.startsWith("image/"));
  return hasImage ? ["text", "image"] : ["text"];
}

function costOf(entry: Record<string, unknown>): Model<Api>["cost"] {
  const text = isRecord(entry.cost) && isRecord(entry.cost.text) ? entry.cost.text : undefined;
  const input = text && isRecord(text.input) ? text.input : undefined;
  const cache = input && isRecord(input.cache) ? input.cache : undefined;
  const output = text && isRecord(text.output) ? text.output : undefined;
  return {
    input: numberField(input, "price"),
    output: numberField(output, "price"),
    cacheRead: numberField(cache, "read"),
    cacheWrite: 0,
  };
}

function thinkingLevelMap(
  entry: Record<string, unknown>,
): Model<Api>["thinkingLevelMap"] | undefined {
  const reasoning = isRecord(entry.capabilities) ? entry.capabilities.reasoning : undefined;
  if (!isRecord(reasoning) || !Array.isArray(reasoning.effort)) return undefined;
  const efforts = reasoning.effort.filter((value): value is string => typeof value === "string");
  if (efforts.length === 0) return undefined;
  const map: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const)
    if (!efforts.includes(level)) map[level] = null;
  return Object.keys(map).length > 0 ? map : undefined;
}

function numberAt(value: unknown, field: string): number {
  return isRecord(value) ? numberField(value, field) : 0;
}

function numberField(value: Record<string, unknown> | undefined, field: string): number {
  const number = value?.[field];
  return typeof number === "number" && Number.isFinite(number) ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
