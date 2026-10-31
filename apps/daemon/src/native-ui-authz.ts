import type { DaemonUiRequest } from "@aeon/protocol";
import type { GrantContext } from "./grant-authority.js";

type UiRequest = Exclude<DaemonUiRequest, { kind: "ping" }>;

const CATALOG_OPERATIONS = [
  "project.list",
  "project.create",
  "project.update",
  "project.pick-folder",
  "chat.create",
  "chat.list",
  "chat.model-catalog",
  "chat.model-login",
  "chat.update",
  "chat.delete",
  "management.home",
  // Home is the Settings page: blocked sites, the form profile and outside context.
  "settings.blocked-sites",
  "settings.form-profile",
  "settings.outside-context",
];
const MANAGEMENT_OPERATIONS = ["management.home", "management.get", "management.action"];

export function authorizeNativeUiScope(context: GrantContext, request: UiRequest): boolean {
  if (context.role !== "ui" || !context.scope) return false;
  if (context.scope.kind === "management") return isCommandFor(request, MANAGEMENT_OPERATIONS);
  if (context.scope.kind === "catalog") return isCommandFor(request, CATALOG_OPERATIONS);
  return authorizesChatScope(context.scope.chatId, request);
}

function isCommandFor(request: UiRequest, operations: readonly string[]): boolean {
  return request.kind === "command" && operations.includes(request.operation);
}

function authorizesChatScope(chatId: string, request: UiRequest): boolean {
  // These two are about the machine's models, not one Chat, so a Chat page may ask too.
  if (isCommandFor(request, ["chat.model-catalog", "chat.model-login"])) return true;
  const requestedChatId = requestedChatIdOf(request);
  return requestedChatId === chatId && !isGlobalChatCommand(request);
}

function requestedChatIdOf(request: UiRequest): string | undefined {
  if (request.kind !== "command") return request.chatId;
  return "chatId" in request.payload ? request.payload.chatId : undefined;
}

function isGlobalChatCommand(request: UiRequest): boolean {
  return (
    request.kind === "command" &&
    (request.operation === "chat.create" || request.operation === "chat.list")
  );
}
