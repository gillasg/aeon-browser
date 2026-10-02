import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiModelCatalog, PiModelOption } from "@pippin/domain";
import { createLocalFixtureModel } from "./fixture-model.js";

interface ModelCatalogOptions {
  sessionDirectory: string;
  agentDirectory: string | undefined;
  testModel: "local-faux" | undefined;
  preferredInitialModel: { provider: string; id: string } | undefined;
}

export async function readPiModelCatalog(options: ModelCatalogOptions): Promise<PiModelCatalog> {
  if (options.testModel && options.agentDirectory)
    return readFixtureCatalog(options.agentDirectory);

  const runtime = await ModelRuntime.create();
  const models = runtime.getAvailableSnapshot();
  const settings = SettingsManager.create(options.sessionDirectory, options.agentDirectory);
  const selectedDefault =
    models.find(
      (model) =>
        model.provider === options.preferredInitialModel?.provider &&
        model.id === options.preferredInitialModel?.id,
    ) ??
    models.find(
      (model) =>
        model.provider === settings.getDefaultProvider() && model.id === settings.getDefaultModel(),
    ) ??
    models[0];
  return {
    defaultModel: selectedDefault
      ? {
          provider: selectedDefault.provider,
          id: selectedDefault.id,
          name: selectedDefault.name,
        }
      : null,
    models: models.map((model) => toModelOption(model, getInitialThinkingLevel(settings, model))),
  };
}

async function readFixtureCatalog(agentDirectory: string): Promise<PiModelCatalog> {
  const fixture = await createLocalFixtureModel(agentDirectory);
  const models = fixture.modelRuntime.getAvailableSnapshot();
  const selected =
    models.find(
      (model) => model.provider === fixture.model.provider && model.id === fixture.model.id,
    ) ?? fixture.model;
  return {
    defaultModel: { provider: selected.provider, id: selected.id, name: selected.name },
    models: [toModelOption(selected, "off")],
  };
}

function toModelOption(model: Model<Api>, defaultThinkingLevel: string): PiModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    thinkingLevels: getSupportedThinkingLevels(model),
    defaultThinkingLevel,
  };
}

function getInitialThinkingLevel(settings: SettingsManager, model: Model<Api>): string {
  const requested =
    settings.getModelThinkingLevel(model.provider, model.id) ??
    settings.getDefaultThinkingLevel() ??
    "medium";
  return clampThinkingLevel(model, requested as ModelThinkingLevel);
}

const catalogCaches = new WeakMap<
  object,
  { expiresAt: number; pending: Promise<PiModelCatalog> }
>();
export function readCachedPiModelCatalog(
  owner: object,
  options: ModelCatalogOptions,
): Promise<PiModelCatalog> {
  const cached = catalogCaches.get(owner);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const pending = readPiModelCatalog(options);
  catalogCaches.set(owner, { expiresAt: Date.now() + 60_000, pending });
  void pending.catch(() => {
    if (catalogCaches.get(owner)?.pending === pending) catalogCaches.delete(owner);
  });
  return pending;
}
