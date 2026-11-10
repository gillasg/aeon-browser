import { toOffscreen } from "./code-offscreen-host.js";
import { callClass, send } from "./cdp/send.js";
import { setTabRecording, showAgentGlow } from "./native-browser-cursor.js";
import { beginManualScreencast, endManualScreencast } from "./native-browser-screencast.js";
import { browserSessionOwner, withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";

// Video recordings of a tab for page.recordVideo: a real video file (MP4 where Chrome can encode
// it, else WebM) made by MediaRecorder in the offscreen document. Tab capture gives true pixels
// and the tab's sound, but Chrome allows it only on a tab the user has invoked the extension on
// (its toolbar button, side panel or shortcut); elsewhere the DevTools screencast is drawn onto
// a canvas and encoded, without sound. While a tab records, nothing of ours is drawn on it: no
// glow, caption or hand-off card (the cursor only when asked for), so the video shows the page.

interface Recording {
  mode: "tab" | "screencast";
  audio: boolean;
  startedAt: number;
  fps: number;
  /** Capture time (s) of the last screencast frame sent to the encoder. */
  lastSent: number;
  /** Attached for this recording alone (a page no chat drives, like Aeon's own chat tab). */
  direct: boolean;
}
const recordings = new Map<number, Recording>();
const STORE = "aeon-recordings";

/**
 * Takes and recordings live in the service worker, which Chrome may restart mid-run; the videos
 * themselves are safe in the offscreen document. Both maps are mirrored to session storage and
 * read back at start, so a restart neither loses a take nor stops its frames reaching the encoder.
 */
let saving: ReturnType<typeof setTimeout> | undefined;
export function saveRecordings(): void {
  if (saving || !chrome.storage?.session) return;
  saving = setTimeout(() => {
    saving = undefined;
    void chrome.storage.session
      .set({ [STORE]: { takes: [...takeTabs], recordings: [...recordings] } })
      .catch(() => undefined);
  }, 200);
}
async function restoreRecordings(): Promise<void> {
  if (!chrome.storage?.session) return;
  const all: Record<string, unknown> = await chrome.storage.session.get(STORE).catch(() => ({}));
  const stored = all[STORE] as
    { takes?: [number, TakeTab][]; recordings?: [number, Recording][] } | undefined;
  for (const [tabId, take] of stored?.takes ?? [])
    if (!takeTabs.has(tabId)) takeTabs.set(tabId, take);
  for (const [tabId, entry] of stored?.recordings ?? [])
    if (!recordings.has(tabId)) recordings.set(tabId, entry);
}

/**
 * Tabs the recordAgentTabs setting records (native-browser-takes.ts). Their recording is stopped and
 * kept, not cancelled, when the tab closes, so a screen recorder can still collect it.
 */
export interface TakeTab {
  chatId: string;
  url: string;
  startedAt: number;
  error?: string;
  stopped?: Record<string, unknown>;
  /** The chat's own tab (the prompt and the answer), not a page the agent drove. */
  chat?: boolean;
  /** When the take stopped or failed (for dropping uncollected takes). */
  endedAt?: number;
  /** The tab's latest title and favicon (http only), so a recorder can draw its tab. */
  title?: string;
  favicon?: string;
}
export const takeTabs = new Map<number, TakeTab>();

/** Stops a take's recording once and remembers the result (the video stays in the offscreen document). */
export async function stopTake(tabId: number): Promise<TakeTab | undefined> {
  const take = takeTabs.get(tabId);
  if (!take || take.stopped || take.error) return take;
  try {
    take.stopped = (await stop(tabId)) as Record<string, unknown>;
  } catch (error) {
    take.error = String(error instanceof Error ? error.message : error);
  }
  saveRecordings();
  return take;
}

export const startRecording = (tabId: number, value: Record<string, unknown>): Promise<unknown> =>
  start(tabId, value);
const OFFSCREEN = "aeon-code-offscreen";
const SLICE = 750_000;

export async function recordingCall(
  tabId: number,
  value: Record<string, unknown>,
): Promise<unknown> {
  if (value.recording === "start") return start(tabId, value);
  if (value.recording === "stop") return stop(tabId);
  if (value.recording === "read")
    return toOffscreen({
      target: OFFSCREEN,
      kind: "recordRead",
      tabId,
      offset: Number(value.offset) || 0,
      size: SLICE,
    });
  if (value.recording === "drop")
    return toOffscreen({ target: OFFSCREEN, kind: "recordDrop", tabId });
  if (value.recording === "cancel") return cancel(tabId);
  if (value.recording === "status") {
    const entry = recordings.get(tabId);
    return entry
      ? { recording: true, ...entry, seconds: (Date.now() - entry.startedAt) / 1000 }
      : { recording: false };
  }
  throw new Error("UNSUPPORTED");
}

function recordingOptions(value: Record<string, unknown>) {
  return {
    audio: value.audio !== false,
    format: value.format === "webm" ? "webm" : "mp4",
    fps: Math.max(5, Math.min(60, Number(value.fps) || 30)),
  };
}

async function start(tabId: number, value: Record<string, unknown>): Promise<unknown> {
  if (recordings.has(tabId))
    throw new Error("RECORDING_ACTIVE: this tab is already recording; stop it first");
  const options = recordingOptions(value);
  setTabRecording(tabId, {
    cursor: value.cursor === true,
    ...(value.pill === true ? { pill: true } : {}),
  });
  void chrome.tabs
    .sendMessage(tabId, { kind: "browserkit.recording", recording: true })
    .catch(() => undefined);
  try {
    const direct = value.direct === true;
    const captured = await startTabCapture(tabId, options);
    const result = captured.ok ? captured : await startScreencast(tabId, options, direct);
    if (!result.ok) throw new Error("RECORDING_FAILED: " + result.error);
    const mode = captured.ok ? "tab" : "screencast";
    recordings.set(tabId, {
      mode,
      audio: mode === "tab" && options.audio,
      startedAt: Date.now(),
      fps: options.fps,
      lastSent: 0,
      direct: !captured.ok && direct,
    });
    saveRecordings();
    return {
      mode,
      audio: mode === "tab" && options.audio,
      mimeType: result.mimeType,
      ...(captured.ok
        ? {}
        : {
            note:
              "No sound: Chrome records a tab's picture and sound only after the user clicks the extension's toolbar button on that tab once. " +
              captured.error,
          }),
    };
  } catch (error) {
    await finish(tabId);
    throw error;
  }
}

type Started = { ok: true; mimeType: string } | { ok: false; error: string };

async function startTabCapture(
  tabId: number,
  options: { audio: boolean; format: string; fps: number },
): Promise<Started> {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return (await toOffscreen({
      target: OFFSCREEN,
      kind: "recordStart",
      tabId,
      streamId,
      ...options,
    })) as Started;
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

/**
 * A debugger command for the recording. Agent tabs go through the chat's session; a direct
 * recording attaches on its own (no chat owns the tab, so no agent can drive it through this).
 */
async function debug(
  tabId: number,
  direct: boolean,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!direct) return withBrowserDebugger(tabId, (debuggee) => debugSend(debuggee, method, params));
  return debugSend({ tabId }, method, params);
}

function debugSend(
  target: chrome.debugger.Debuggee,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return send(target, method, params, debugOpts(method));
}

function debugOpts(method: string): { label: string; ms?: number } {
  if (callClass(method) !== "eval") return { label: "debug" };
  return { label: "debug", ms: 5_000 };
}

async function attachDirect(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, "1.3").catch((error: unknown) => {
    if (!/already attached/i.test(String(error))) throw error;
  });
  // Paint as if focused, so a background tab keeps producing frames.
  await send(
    { tabId },
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    { label: "attachDirect" },
  ).catch(() => undefined);
}

async function startScreencast(
  tabId: number,
  options: { format: string; fps: number },
  direct: boolean,
): Promise<Started> {
  const started = (await toOffscreen({
    target: OFFSCREEN,
    kind: "recordStart",
    tabId,
    canvas: true,
    audio: false,
    ...options,
  })) as Started;
  if (!started.ok) return started;
  beginManualScreencast(tabId);
  if (direct) await attachDirect(tabId);
  await debug(tabId, direct, "Page.startScreencast", {
    format: "jpeg",
    quality: 85,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });
  return started;
}

async function stop(tabId: number): Promise<unknown> {
  const entry = recordings.get(tabId);
  if (!entry) throw new Error("NOT_RECORDING: this tab has no recording to stop");
  try {
    const result = (await toOffscreen({ target: OFFSCREEN, kind: "recordStop", tabId })) as {
      ok: boolean;
      error?: string;
      bytes?: number;
      mimeType?: string;
    };
    if (!result.ok) throw new Error("RECORDING_FAILED: " + (result.error ?? "no video"));
    return { ...result, mode: entry.mode, audio: entry.audio, ms: Date.now() - entry.startedAt };
  } finally {
    await finish(tabId);
  }
}

async function cancel(tabId: number): Promise<unknown> {
  await toOffscreen({ target: OFFSCREEN, kind: "recordDrop", tabId }).catch(() => undefined);
  await finish(tabId);
  return { cancelled: true };
}

async function finish(tabId: number): Promise<void> {
  const entry = recordings.get(tabId);
  recordings.delete(tabId);
  saveRecordings();
  setTabRecording(tabId, undefined);
  if (entry?.mode === "screencast")
    await debug(tabId, entry.direct, "Page.stopScreencast", {}).catch(() => undefined);
  if (entry?.direct) await chrome.debugger.detach({ tabId }).catch(() => undefined);
  await endManualScreencast(tabId);
  void chrome.tabs
    .sendMessage(tabId, { kind: "browserkit.recording", recording: false })
    .catch(() => undefined);
  if (browserSessionOwner(tabId)) void showAgentGlow(tabId);
}

onEngineInstall(() => {
  void restoreRecordings();
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Page.screencastFrame" || source.tabId === undefined) return;
    const recording = recordings.get(source.tabId);
    if (recording?.mode !== "screencast") return;
    const frame = params as { data?: string; metadata?: { timestamp?: number } };
    // Chrome can send 100+ frames a second; the encoder needs one per frame slot, so the rest are
    // never sent (that is the frame rate, not a loss).
    const capturedAt = frame.metadata?.timestamp ?? 0;
    if (capturedAt && capturedAt - recording.lastSent < (1 / recording.fps) * 0.97) return;
    recording.lastSent = capturedAt;
    if (frame.data)
      void toOffscreen({
        target: OFFSCREEN,
        kind: "recordFrame",
        tabId: source.tabId,
        data: frame.data,
        capturedAt: frame.metadata?.timestamp,
      }).catch(() => undefined);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (takeTabs.has(tabId)) void stopTake(tabId);
    else if (recordings.has(tabId)) void cancel(tabId);
  });
});
