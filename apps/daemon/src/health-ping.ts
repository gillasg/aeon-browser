import { randomUUID } from "node:crypto";
import { SUPPORTED_PROTOCOL_VERSION, type ProtocolVersion } from "@aeon/protocol";

// One health check for doctor and the supervisor. The daemon's event loop asks the extension;
// the engine answers on its next turn, so a stuck loop cannot look healthy. Two seconds.
export const HEALTH_BUDGET_MS = 2000;
export const HEALTH_REQUEST_KIND = "browser.host.health";
export const HEALTH_RESULT_KIND = "browser.host.result";
export const SUPERVISOR_HEALTH_KIND = "supervisor.health";
export const SUPERVISOR_HEALTH_RESULT_KIND = "supervisor.health.result";

export interface HealthReport {
  ok: boolean;
  daemon: true;
  extension: boolean;
  engine: boolean;
  protocolVersion: ProtocolVersion;
  engineProtocol?: ProtocolVersion;
  ms: number;
}

interface HostResult {
  kind: string;
  requestId: string;
  ok?: unknown;
  result?: unknown;
}

type Send = (body: Record<string, unknown>) => boolean;

/** Pending engine replies, keyed by the request the daemon just sent. */
export class HealthPings {
  private readonly pending = new Map<string, (reply: HostResult) => void>();

  ping(send: Send, budgetMs = HEALTH_BUDGET_MS): Promise<HealthReport> {
    const requestId = randomUUID();
    const nonce = randomUUID();
    const started = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (report: HealthReport): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(report);
      };
      const timer = setTimeout(() => finish(miss(started)), budgetMs);
      this.pending.set(requestId, (reply) => finish(fromReply(reply, nonce, started)));
      if (!send(healthRequest(requestId, nonce))) finish(miss(started));
    });
  }

  /** True when this is an engine reply, so the executor socket is not closed as unknown. */
  handleReply(candidate: unknown): boolean {
    if (!isHostResult(candidate)) return false;
    this.pending.get(candidate.requestId)?.(candidate);
    return true;
  }
}

export function isSupervisorHealthLine(line: string): boolean {
  return decodeLine(line)?.kind === SUPERVISOR_HEALTH_KIND;
}

export function supervisorHealthLine(report: HealthReport): string {
  return Buffer.from(
    JSON.stringify({ kind: SUPERVISOR_HEALTH_RESULT_KIND, ...report }),
    "utf8",
  ).toString("base64");
}

function healthRequest(requestId: string, nonce: string): Record<string, unknown> {
  return {
    kind: HEALTH_REQUEST_KIND,
    action: "health",
    requestId,
    nonce,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  };
}

function fromReply(message: HostResult, nonce: string, started: number): HealthReport {
  const result = message.result as { nonce?: unknown; protocolVersion?: unknown } | undefined;
  const engineProtocol = versionOf(result?.protocolVersion);
  const engine = message.ok === true && result?.nonce === nonce && engineProtocol !== undefined;
  return {
    ok: engine,
    daemon: true,
    extension: true,
    engine,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ...(engine && engineProtocol ? { engineProtocol } : {}),
    ms: elapsed(started),
  };
}

function miss(started: number): HealthReport {
  return {
    ok: false,
    daemon: true,
    extension: false,
    engine: false,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ms: elapsed(started),
  };
}

function versionOf(value: unknown): ProtocolVersion | undefined {
  const version = value as { major?: unknown; minor?: unknown } | undefined;
  if (!version || typeof version.major !== "number" || typeof version.minor !== "number")
    return undefined;
  return { major: version.major, minor: version.minor };
}

function isHostResult(candidate: unknown): candidate is HostResult {
  const message = candidate as Partial<HostResult> | null;
  return message?.kind === HEALTH_RESULT_KIND && typeof message.requestId === "string";
}

function decodeLine(line: string): { kind?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as { kind?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}
