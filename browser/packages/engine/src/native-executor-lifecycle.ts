import {
  BrowserExecutorHeartbeatReplySchema,
  BrowserExecutorHeartbeatSchema,
} from "@browserkit/protocol";
import type { BrowserIdentity } from "./native-worker-identity.js";

/** Prepare on worker load, browser startup, and wake before a page requests a grant. */
export function installNativeStartup(connect: () => Promise<unknown>, retry: () => void): void {
  const warm = () => {
    void connect().catch(retry);
  };
  chrome.runtime.onStartup.addListener(warm);
  chrome.runtime.onInstalled.addListener(warm);
  chrome.tabs.onActivated.addListener(warm);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) warm();
  });
  // A service worker can sleep while the daemon restarts; alarms wake it to retry the link. Keep
  // a slow periodic one as a safety net and let scheduleExecutorReconnect arm a faster one-shot.
  void chrome.alarms?.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  chrome.alarms?.onAlarm.addListener((fired) => {
    if (fired.name === RECONNECT_ALARM || fired.name === RECONNECT_NOW_ALARM) warm();
  });
  warm();
}

const RECONNECT_ALARM = "aeon-executor-reconnect";
const RECONNECT_NOW_ALARM = "aeon-executor-reconnect-now";
let timer: number | undefined;
let attempts = 0;
/**
 * Re-establish the browser executor without replaying any browser operation.
 *
 * A MV3 service worker discards plain timers when it sleeps, so a daemon restart that outlasts the
 * short backoff used to leave the link dead until the user restarted Chrome. Alongside the fast
 * timer we arm a one-shot chrome alarm: Chrome wakes the worker to fire it even after sleep, and a
 * fresh bootstrap (new grant, new endpoint) is attempted there. The alarm is cleared once the link
 * is live, so a healthy extension does no extra wake-ups.
 */
export function scheduleExecutorReconnect(connect: () => Promise<unknown>): void {
  if (timer !== undefined) return;
  const delay = Math.min(250 * 2 ** Math.min(attempts++, 4), 4000);
  if (chrome.alarms?.create)
    void chrome.alarms.create(RECONNECT_NOW_ALARM, { when: Date.now() + Math.max(delay, 30_000) });
  timer = globalThis.setTimeout(() => {
    timer = undefined;
    void connect().then(noteExecutorConnected, () => scheduleExecutorReconnect(connect));
  }, delay);
}

/** Stop retrying once a connection is live: clear the timer, the wake alarm and the backoff. */
export function noteExecutorConnected(): void {
  attempts = 0;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (chrome.alarms?.clear) void chrome.alarms.clear(RECONNECT_NOW_ALARM);
}

export function startExecutorHeartbeat(
  socket: WebSocket,
  identity: BrowserIdentity,
  build?: () => string | undefined,
): number {
  let acknowledged = Date.now();
  const onMessage = (event: MessageEvent) => {
    try {
      const reply = BrowserExecutorHeartbeatReplySchema.safeParse(JSON.parse(String(event.data)));
      if (
        reply.success &&
        reply.data.clientInstanceId === identity.clientInstanceId &&
        reply.data.browserRunId === identity.browserRunId
      )
        acknowledged = Date.now();
    } catch {
      /* Other protocol messages are handled by the worker. */
    }
  };
  socket.addEventListener("message", onMessage);
  const timer = globalThis.setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - acknowledged > 65000) {
      socket.close(4004, "Daemon heartbeat expired; reconnect required");
      return;
    }
    try {
      const stamp = build?.();
      socket.send(
        JSON.stringify(
          BrowserExecutorHeartbeatSchema.parse({
            kind: "browser.executor.heartbeat",
            ...identity,
            ...(stamp ? { build: stamp } : {}),
          }),
        ),
      );
    } catch {
      socket.close(4004, "Executor heartbeat failed");
    }
  }, 20000);
  socket.addEventListener(
    "close",
    () => {
      clearInterval(timer);
      socket.removeEventListener("message", onMessage);
    },
    { once: true },
  );
  return timer;
}
