import type { BrowserExecutorRequest } from "@pippin/protocol";
import { releaseBrowserSessions } from "./native-browser-session.js";
const chatEpochs = new Map<string, number>();
const requestEpochs = new Map<string, number>();

export function releaseBrowserExecutor(): void {
  for (const [chatId, epoch] of chatEpochs) chatEpochs.set(chatId, epoch + 1);
  void releaseBrowserSessions();
}
export function handleBrowserRelease(candidate: unknown): boolean {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("kind" in candidate) ||
    candidate.kind !== "browser.release" ||
    !("chatId" in candidate) ||
    typeof candidate.chatId !== "string"
  )
    return false;
  chatEpochs.set(candidate.chatId, (chatEpochs.get(candidate.chatId) ?? 0) + 1);
  void releaseBrowserSessions(candidate.chatId, "reset" in candidate && candidate.reset === true);
  return true;
}
export function registerBrowserRequest(request: BrowserExecutorRequest): void {
  const epoch = chatEpochs.get(request.chatId) ?? 0;
  chatEpochs.set(request.chatId, epoch);
  requestEpochs.set(request.requestId, epoch);
}
export function assertRequestActive(request: BrowserExecutorRequest): void {
  if (requestEpochs.get(request.requestId) !== chatEpochs.get(request.chatId))
    throw new Error("OPERATION_FAILED");
}
export function completeBrowserRequest(request: BrowserExecutorRequest): void {
  requestEpochs.delete(request.requestId);
}
