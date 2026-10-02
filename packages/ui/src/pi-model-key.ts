import type { ComposerModel } from "./chat-composer.js";
export function modelKey(model: Pick<ComposerModel, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}
