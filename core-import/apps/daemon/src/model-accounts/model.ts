import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { LoginService, type ModelAccountOptions } from "./service.js";

/** The user's default model when it is connected, else the first connected provider's model. */
export async function defaultModel(
  options: ModelAccountOptions = {},
): Promise<{ models: MutableModels; model: Model<Api> }> {
  const service = new LoginService(options);
  const available = await service.models.getAvailable();
  const preferred = await service.settings.defaultModel();
  const model =
    (preferred &&
      available.find(
        (item) => item.provider === preferred.provider && item.id === preferred.model,
      )) ||
    available[0];
  if (!model)
    throw new Error(
      "No AI model is connected. Sign in from Aeon's Models page (Settings → Models).",
    );
  return { models: service.models, model };
}
