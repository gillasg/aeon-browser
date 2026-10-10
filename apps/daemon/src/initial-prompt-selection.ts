import type { PiSessionHandle } from "@pippin/domain";
export interface InitialPromptSelection {
  model: { provider: string; id: string };
  thinkingLevel: string;
}
export async function configureInitialPrompt(
  session: PiSessionHandle,
  selection?: InitialPromptSelection,
): Promise<void> {
  if (!selection) return;
  await session.setModel(selection.model.provider, selection.model.id);
  session.setThinkingLevel(selection.thinkingLevel);
}
