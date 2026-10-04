import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiSessionPort, PiDetachedForkEvidence } from "@pippin/domain";
export function findDetachedFork(
  sessionDirectory: string,
  input: Parameters<PiSessionPort["findDetachedFork"]>[0],
): PiDetachedForkEvidence {
  const targetDirectory = join(sessionDirectory, "detached-forks", input.targetChatId);
  if (!existsSync(targetDirectory)) return { kind: "none" };
  const files = readdirSync(targetDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(targetDirectory, name));
  if (!files.length) return { kind: "none" };
  const valid = files.filter((file) => {
    try {
      const manager = SessionManager.open(file, targetDirectory, input.workingDirectory);
      return (
        manager.getHeader()?.parentSession === resolve(input.sourceReference.sessionFile) &&
        manager.getLeafId() === input.entryId &&
        manager.getBranch().some((entry) => entry.id === input.entryId)
      );
    } catch {
      return false;
    }
  });
  const onlyFile = files[0];
  const onlyValidFile = valid[0];
  if (valid.length === 1 && files.length === 1 && onlyFile && onlyValidFile) {
    const manager = SessionManager.open(onlyValidFile, targetDirectory, input.workingDirectory);
    return {
      kind: "found",
      reference: { sessionId: manager.getSessionId(), sessionFile: onlyValidFile },
    };
  }
  return { kind: "ambiguous", count: files.length };
}

export function inspectForkEntry(
  input: Parameters<PiSessionPort["inspectForkEntry"]>[0],
): ReturnType<PiSessionPort["inspectForkEntry"]> {
  const source = SessionManager.open(
    input.reference.sessionFile,
    dirname(input.reference.sessionFile),
    input.workingDirectory,
  );
  const selectedBranch = source.getBranch(input.entryId);
  if (selectedBranch.length === 0) return { supported: false, reason: "entry_not_found" };
  if (
    !selectedBranch.some((entry) => entry.type === "message" && entry.message.role === "assistant")
  )
    return { supported: false, reason: "branch_without_assistant" };
  return { supported: true };
}
