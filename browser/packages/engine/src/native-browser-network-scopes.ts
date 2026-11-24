import { send } from "./cdp/send.js";

// Child debugger sessions: a tab's out-of-process iframes, dedicated/shared workers and service
// workers each get their own session when Target.setAutoAttach is on. Kept here so the network
// recorder can tag entries with where their request came from and read bodies from that session.

export interface ChildScope {
  sessionId?: string;
  source?: "worker" | "service-worker";
  frameUrl?: string;
}

export const childScopes = new Map<string, ChildScope>();

export const NETWORK_BUFFERS = {
  maxTotalBufferSize: 100_000_000,
  maxResourceBufferSize: 10_000_000,
  maxPostDataSize: 1_000_000,
};

export function scopeKey(tabId: number, sessionId: string): string {
  return `${tabId}:${sessionId}`;
}

// While a tab's network is captured, children start paused (waitForDebuggerOnStart), so their
// first requests are not lost before Network.enable reaches the new session. Every
// Target.setAutoAttach call for the tab goes through autoAttachParams: the last call wins, so a
// frame discovery must not switch the pause back off.
const capturing = new Set<number>();

export function setCaptureActive(tabId: number, on: boolean): void {
  if (on) capturing.add(tabId);
  else capturing.delete(tabId);
}

export function captureActive(tabId: number): boolean {
  return capturing.has(tabId);
}

export function autoAttachParams(tabId: number): {
  autoAttach: true;
  waitForDebuggerOnStart: boolean;
  flatten: true;
} {
  return { autoAttach: true, waitForDebuggerOnStart: captureActive(tabId), flatten: true };
}

/** A paused child is resumed at the latest this long after it attached, whatever else hangs. */
export const RESUME_CAP_MS = 2_000;

type Send = (
  target: { tabId: number; sessionId: string },
  method: string,
  params?: object,
) => Promise<unknown>;

/**
 * Enables Network on a new child session, then resumes it if it started paused. The resume runs
 * in finally, after at most RESUME_CAP_MS, so a child never stays paused.
 */
export async function startChild(
  tabId: number,
  sessionId: string,
  waiting: boolean,
  enable: boolean,
  call: Send,
  capMs = RESUME_CAP_MS,
): Promise<void> {
  const target = { tabId, sessionId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (enable)
      await Promise.race([
        call(target, "Network.enable", NETWORK_BUFFERS).catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, capMs);
        }),
      ]);
  } finally {
    clearTimeout(timer);
    if (waiting) await call(target, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
  }
}

const sendChild: Send = (target, method, params) =>
  send(target, method, params, { label: "attachChild" });

/** A worker or out-of-process iframe attached: record its requests in the same tab's store. */
export function attachChild(
  tabId: number,
  params: Record<string, unknown>,
  call: Send = sendChild,
): Promise<void> {
  const info = params.targetInfo as { type?: string; url?: string } | undefined;
  const sessionId = String(params.sessionId ?? "");
  const type = info?.type ?? "";
  const waiting = params.waitingForDebugger === true;
  if (!sessionId) return Promise.resolve();
  if (!["worker", "service_worker", "shared_worker", "iframe"].includes(type))
    return startChild(tabId, sessionId, waiting, false, call);
  const source: ChildScope["source"] =
    type === "service_worker"
      ? "service-worker"
      : type === "worker" || type === "shared_worker"
        ? "worker"
        : undefined;
  childScopes.set(scopeKey(tabId, sessionId), {
    ...(info?.url ? { frameUrl: info.url } : {}),
    ...(source ? { source } : {}),
  });
  return startChild(tabId, sessionId, waiting, true, call);
}
