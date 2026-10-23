import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type OpenPiSessionInput,
  type PiSessionReference,
  PiSessionUnavailableError,
} from "@aeon/domain";

export function resolvePiSessionManager(
  input: OpenPiSessionInput,
  sessionDirectory: string,
): SessionManager {
  if (input.reference && input.reference.sessionId !== input.activationId) {
    throw new Error("Stored Pi session identity does not match the durable activation ID.");
  }
  if (input.reference) {
    const storedPath = assertOwnedSessionPath(sessionDirectory, input.reference.sessionFile);
    if (existsSync(storedPath)) return restoreManager(storedPath, input);
  }
  const discovered = SessionManager.findById(
    input.workingDirectory,
    input.activationId,
    sessionDirectory,
  );
  if (discovered) {
    return restoreManager(assertOwnedSessionPath(sessionDirectory, discovered), input);
  }
  if (input.reference && input.materialized) {
    throw new PiSessionUnavailableError("The materialized Pi session file is missing.");
  }
  return SessionManager.create(input.workingDirectory, sessionDirectory, {
    id: input.activationId,
  });
}

export function sessionReferenceFromManager(manager: SessionManager): PiSessionReference {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Pi did not provide a durable session file path.");
  return { sessionId: manager.getSessionId(), sessionFile: resolve(sessionFile) };
}

export type StoredThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function storedThinkingLevel(manager: SessionManager): StoredThinkingLevel | undefined {
  for (const entry of [...manager.getEntries()].reverse()) {
    if (entry.type === "thinking_level_change" && isThinkingLevel(entry.thinkingLevel)) {
      return entry.thinkingLevel;
    }
  }
  return undefined;
}

function restoreManager(path: string, input: OpenPiSessionInput): SessionManager {
  try {
    const manager = SessionManager.open(path, undefined, input.workingDirectory);
    if (manager.getSessionId() !== input.activationId) {
      throw new Error("Pi session file identity does not match the durable activation ID.");
    }
    return manager;
  } catch (error) {
    if (input.materialized) {
      throw new PiSessionUnavailableError("The persisted Pi session could not be restored.", {
        cause: error,
      });
    }
    throw error;
  }
}

export function assertOwnedSessionPath(sessionDirectory: string, sessionFile: string): string {
  const root = resolve(sessionDirectory);
  const path = resolve(sessionFile);
  const relativePath = relative(root, path);
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath) ||
    !path.toLowerCase().endsWith(".jsonl")
  ) {
    throw new Error("Stored Pi session path is outside Aeon's Pi session directory.");
  }
  if (!existsSync(path)) return path;
  const physicalRoot = existsSync(root) ? realpathSync(root) : root;
  const physicalRelative = relative(physicalRoot, realpathSync(path));
  if (
    physicalRelative.startsWith(`..${sep}`) ||
    physicalRelative === ".." ||
    isAbsolute(physicalRelative)
  ) {
    throw new Error("Pi session file resolves outside Aeon's Pi session directory.");
  }
  return realpathSync(path);
}

function isThinkingLevel(value: string): value is StoredThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
