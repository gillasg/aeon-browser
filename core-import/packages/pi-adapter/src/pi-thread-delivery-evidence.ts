import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const PI_THREAD_MESSAGE_CUSTOM_TYPE = "pippin.thread-message.v1";
export const PI_THREAD_SETTLEMENT_CUSTOM_TYPE = "pippin.thread-settlement.v1";

export function findMessageEntry(
  manager: SessionManager,
  deliveryId: string,
): SessionEntry | undefined {
  return manager.getBranch().find((entry) => messageDetails(entry)?.deliveryId === deliveryId);
}

export function findReceipt(
  manager: SessionManager,
  deliveryId: string,
): { state: "completed" | "failed"; acceptedTurnId: string } | undefined {
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== PI_THREAD_SETTLEMENT_CUSTOM_TYPE) continue;
    const details = entry.data;
    if (
      isRecord(details) &&
      details.deliveryId === deliveryId &&
      (details.state === "completed" || details.state === "failed") &&
      typeof details.acceptedTurnId === "string"
    )
      return { state: details.state, acceptedTurnId: details.acceptedTurnId };
  }
  return undefined;
}

export function messageDetails(entry: SessionEntry): Record<string, unknown> | undefined {
  if (entry.type !== "custom_message" || entry.customType !== PI_THREAD_MESSAGE_CUSTOM_TYPE) return;
  return isRecord(entry.details) ? entry.details : undefined;
}

export function threadMessage(
  entry: SessionEntry,
): { deliveryId: string; recipientChatId: string } | undefined {
  const details = messageDetails(entry);
  if (!details) return undefined;
  const deliveryId = stringProperty(details, "deliveryId");
  const recipientChatId = stringProperty(details, "recipientChatId");
  return deliveryId && recipientChatId ? { deliveryId, recipientChatId } : undefined;
}

export function latestTurnFailed(manager: SessionManager): boolean {
  const entries = manager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message.role === "assistant")
      return entry.message.stopReason === "error" || entry.message.stopReason === "aborted";
  }
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
