import type { DaemonUiRequest } from "@aeon/protocol";
import type { GrantContext } from "./grant-authority.js";

export function authorizeNativeUiScope(context: GrantContext, request: DaemonUiRequest): boolean {
  if (context.role !== "ui" || !context.scope) return false;
  if (context.scope.kind === "management")
    return (
      request.kind === "command" &&
      ["management.home", "management.get", "management.action"].includes(request.operation)
    );
  if (context.scope.kind === "catalog")
    return (
      request.kind === "command" &&
      [
        "project.list",
        "project.create",
        "project.update",
        "project.pick-folder",
        "chat.create",
        "chat.list",
        "chat.model-catalog",
        "chat.update",
        "chat.delete",
        "management.home",
      ].includes(request.operation)
    );
  const requestedChatId =
    request.kind === "command"
      ? "chatId" in request.payload
        ? request.payload.chatId
        : undefined
      : request.chatId;
  return (
    requestedChatId === context.scope.chatId &&
    (request.kind !== "command" ||
      (request.operation !== "chat.create" && request.operation !== "chat.list"))
  );
}
