import { modelUnavailable } from "./model-unavailable.js";

// Which model one-off calls use: an explicitly named one, else the person's default, else Graft's
// preferred model when it is connected, else the first connected model. A choice the person made
// that is gone is never swapped out silently: the error says which provider to sign in to again.

export interface CompletionModelChoice {
  model?: string | undefined;
}

export interface StoredModelDefaults {
  getDefaultProvider(): string | undefined;
  getDefaultModel(): string | undefined;
}

export interface ModelReference {
  provider: string;
  id: string;
}

export function chooseCompletionModel<ModelType extends ModelReference>(
  models: readonly ModelType[],
  defaults: StoredModelDefaults,
  choice: CompletionModelChoice,
  preferred: ModelReference | undefined,
): ModelType {
  const explicit = choiceReference(choice.model);
  if (explicit) return requireModel(models, explicit);
  const stored = referenceOf(defaults.getDefaultProvider(), defaults.getDefaultModel());
  if (stored) return requireModel(models, stored);
  const preferredModel = preferred ? findModel(models, preferred) : undefined;
  if (preferredModel) return preferredModel;
  const first = models[0];
  if (first) return first;
  throw new Error(
    'No AI model is connected. Sign in from the model picker ("Add or manage models…").',
  );
}

function referenceOf(provider?: string, id?: string): ModelReference | undefined {
  return provider && id ? { provider, id } : undefined;
}

function choiceReference(value?: string): ModelReference | undefined {
  if (!value) return undefined;
  const [provider, ...id] = value.split("/");
  if (!provider || !id.length) throw new Error(`Choose a model as provider/model, not "${value}".`);
  return { provider, id: id.join("/") };
}

function findModel<ModelType extends ModelReference>(
  models: readonly ModelType[],
  reference: ModelReference,
): ModelType | undefined {
  return models.find((model) => model.provider === reference.provider && model.id === reference.id);
}

function requireModel<ModelType extends ModelReference>(
  models: readonly ModelType[],
  reference: ModelReference,
): ModelType {
  const model = findModel(models, reference);
  if (!model) throw modelUnavailable(reference.provider, reference.id);
  return model;
}
