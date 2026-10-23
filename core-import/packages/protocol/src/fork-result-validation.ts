import { z } from "zod";
export function validateUnsupportedFork(
  result: { status: string; targetChatId: string | null; chat: unknown; reason: string | null },
  context: z.RefinementCtx,
): void {
  if (
    result.status === "unsupported" &&
    (result.targetChatId !== null ||
      result.chat !== null ||
      !["chat_not_ready", "entry_not_found", "branch_without_assistant"].includes(
        result.reason ?? "",
      ))
  )
    context.addIssue({
      code: "custom",
      message: "An unsupported fork must not return a child.",
    });
}
export function validateFailedFork(
  result: { status: string; targetChatId: string | null; chat: unknown; reason: string | null },
  context: z.RefinementCtx,
): void {
  if (
    (result.status === "failed" || result.status === "uncertain") &&
    (!result.targetChatId ||
      result.chat !== null ||
      result.reason !== (result.status === "failed" ? "fork_failed" : "outcome_uncertain"))
  )
    context.addIssue({
      code: "custom",
      message: "A failed fork requires its target identity.",
    });
}
