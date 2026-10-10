import type { DaemonUiRequest } from "@aeon/protocol";

export type CommandRequest = Extract<DaemonUiRequest, { kind: "command" }>;
export type BrowserContextAttachStatus = "attached" | "stale" | "lost" | "offline";
export type ReadCommandRequest = Extract<
  CommandRequest,
  {
    operation:
      | "project.list"
      | "project.create"
      | "project.update"
      | "project.pick-folder"
      | "workspace.file"
      | "chat.model-catalog"
      | "chat.create"
      | "chat.list"
      | "chat.get"
      | "chat.resources"
      | "management.get"
      | "management.home"
      | "chat.pi-ui"
      | "chat.navigate-tree"
      | "chat.edit-message"
      | "chat.fork-message"
      | "chat.compact"
      | "chat.extension-ui-answer"
      | "chat.delete"
      | "chat.update"
      | "chat.controls"
      | "chat.model"
      | "chat.thinking"
      | "chat.attach-browser-context"
      | "chat.queue"
      | "chat.queue-edit"
      | "chat.stop";
  }
>;
export type NonSubmitCommand = Exclude<
  CommandRequest,
  {
    operation:
      | "chat.submit"
      | "workspace.file"
      | "project.list"
      | "project.create"
      | "project.update"
      | "project.pick-folder";
  }
>;
export type ManagementActionCommand = Extract<CommandRequest, { operation: "management.action" }>;
export type SimpleCommand = Extract<
  Exclude<NonSubmitCommand, { operation: "chat.delete" }>,
  {
    operation:
      | "chat.model-catalog"
      | "chat.create"
      | "chat.list"
      | "chat.get"
      | "chat.resources"
      | "management.get"
      | "management.home"
      | "chat.pi-ui"
      | "chat.delete"
      | "chat.update"
      | "chat.controls";
  }
>;
export type SessionCommand = Extract<
  NonSubmitCommand,
  {
    operation:
      | "chat.model"
      | "chat.thinking"
      | "chat.stop"
      | "chat.navigate-tree"
      | "chat.edit-message"
      | "chat.fork-message"
      | "chat.compact"
      | "chat.extension-ui-answer";
  }
>;
export type ContextCommand = Extract<
  NonSubmitCommand,
  { operation: "chat.attach-browser-context" | "chat.queue" | "chat.queue-edit" }
>;

const SIMPLE_COMMANDS = new Set([
  "chat.model-catalog",
  "chat.create",
  "chat.list",
  "chat.get",
  "chat.resources",
  "management.get",
  "management.home",
  "chat.pi-ui",
  "chat.update",
  "chat.controls",
]);
const SESSION_COMMANDS = new Set([
  "chat.model",
  "chat.thinking",
  "chat.stop",
  "chat.navigate-tree",
  "chat.edit-message",
  "chat.fork-message",
  "chat.compact",
  "chat.extension-ui-answer",
]);
const CONTEXT_COMMANDS = new Set(["chat.attach-browser-context", "chat.queue", "chat.queue-edit"]);

export function isSimpleCommand(request: NonSubmitCommand): request is SimpleCommand {
  return SIMPLE_COMMANDS.has(request.operation);
}

export function isSessionCommand(request: NonSubmitCommand): request is SessionCommand {
  return SESSION_COMMANDS.has(request.operation);
}

export function isContextCommand(request: NonSubmitCommand): request is ContextCommand {
  return CONTEXT_COMMANDS.has(request.operation);
}
