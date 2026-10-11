export { mountAeonUi } from "./mount.js";
export { ChatSurface, type ChatSurfaceProps } from "./chat-surface.js";
export {
  ChatComposer,
  type ChatComposerProps,
  type ComposerAttachment,
  type ComposerControls,
  type ComposerModel,
} from "./chat-composer.js";
export { PiModelPicker, PiThinkingPicker, modelKey } from "./pi-model-picker.js";
export { NewTabHome, type NewTabHomeProps } from "./home-surface.js";
export { ManagementSurface, type ManagementSurfaceProps } from "./management-surface.js";
export type { ManagementActionName, ManagementSection } from "./management-types.js";
export { SidePanel, type SidePanelProps } from "./side-panel.js";
export { TranscriptModel, type TranscriptRow } from "./transcript-model.js";
export { projectEditDiff } from "./tool-edit-diff.js";
export { PromptField } from "./prompt-field.js";
export { PiSessionPanel, type PiSessionPanelProps } from "./pi-session-panel.js";
export { ExtensionDialogs } from "./extension-dialogs.js";
export {
  LoadedResources,
  type LoadedResourcesProps,
  type LoadedResourcesState,
} from "./loaded-resources.js";

export { ChatMarkdown } from "./chat-markdown.js";
export { HANDOFF_EVENT, type HandoffAction } from "./handoff-card.js";
