// page.streams: WebSocket, server-sent event and (opt-in) RTCDataChannel messages of one tab, kept
// in a bounded, scrubbed ring and described as compact stream descriptors. Strictly lazy: a tab
// with no started tap costs one Map lookup per debugger event, and no domain is enabled for it.
import { send } from "./cdp/send.js";
import { holdBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { publishBrowserEvent } from "./native-browser-events.js";
import {
  Ring,
  installTap,
  readFilter,
  removeTap,
  scrubText,
  shapeOf,
  toPayload,
  urlPattern,
  waitMs,
  type PayloadFormat,
  type RealtimeItem,
} from "./native-browser-realtime.js";

export type StreamKind = "ws" | "sse" | "webrtc";
export interface StreamFrame extends RealtimeItem {
  kind: StreamKind;
  direction: "received" | "sent";
  stream: string;
  format: PayloadFormat;
  bytes: number;
  truncated: boolean;
  event?: string;
}
interface Descriptor {
  url: string;
  kind: StreamKind;
  directions: Set<string>;
  formats: Set<string>;
  events: Set<string>;
  schema: Record<string, Set<string>>;
  samples: number;
}
interface TabStreams {
  ring: Ring<StreamFrame>;
  urls: Map<string, string>;
  descriptors: Map<string, Descriptor>;
  webrtc?: string;
  open: Set<string>;
}

export const STREAM_EVENT = "Aeon.streamFrame";
const RTC_BINDING = "__aeonRtcTap";
const tabs = new Map<number, TabStreams>();
const listeners = new Set<(tabId: number, frame: StreamFrame) => void>();

/** Live watchers (and tests) hear every stored frame without polling. */
export function onStreamFrame(listener: (tabId: number, frame: StreamFrame) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function streamsActive(tabId: number): boolean {
  return tabs.has(tabId);
}

function describe(entry: TabStreams, frame: StreamFrame): void {
  const url = urlPattern(frame.url);
  const key = `${frame.kind} ${url}`;
  const found = entry.descriptors.get(key) ?? {
    url,
    kind: frame.kind,
    directions: new Set(),
    formats: new Set(),
    events: new Set(),
    schema: {},
    samples: 0,
  };
  found.samples++;
  found.directions.add(frame.direction);
  found.formats.add(frame.format);
  if (frame.event) found.events.add(frame.event);
  for (const [path, type] of Object.entries(shapeOf(frame.json)))
    if (Object.keys(found.schema).length < 80 || found.schema[path])
      (found.schema[path] ??= new Set()).add(type);
  entry.descriptors.set(key, found);
}

interface RawFrame {
  kind: StreamKind;
  direction: "received" | "sent";
  stream: string;
  url: string;
  data: unknown;
  binary?: boolean;
  event?: string;
}

/** Stores one frame (scrubbed, capped) and tells watchers. Exported for the CDP-free tests. */
export function recordFrame(tabId: number, raw: RawFrame): StreamFrame | undefined {
  const entry = tabs.get(tabId);
  if (!entry) return undefined;
  const payload = toPayload(raw.data, raw.binary);
  const frame = entry.ring.push({
    at: Date.now(),
    kind: raw.kind,
    direction: raw.direction,
    stream: raw.stream,
    url: scrubText(raw.url),
    data: payload.data,
    bytes: payload.bytes,
    truncated: payload.truncated,
    format: payload.format,
    ...(payload.json === undefined ? {} : { json: payload.json }),
    ...(raw.event ? { event: scrubText(raw.event) } : {}),
  });
  describe(entry, frame);
  for (const listener of listeners) listener(tabId, frame);
  publishBrowserEvent(tabId, STREAM_EVENT, frame as unknown as Record<string, unknown>);
  return frame;
}

type Params = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

function wsFrame(entry: TabStreams, params: Params, direction: "received" | "sent"): RawFrame {
  const id = text(params.requestId);
  const response = (params.response ?? {}) as Params;
  return {
    kind: "ws",
    direction,
    stream: id,
    url: entry.urls.get(id) ?? "",
    data: response.payloadData,
    binary: response.opcode === 2,
  };
}

function rtcFrame(params: Params): RawFrame | undefined {
  if (params.name !== RTC_BINDING) return undefined;
  try {
    const message = JSON.parse(text(params.payload)) as Params;
    return {
      kind: "webrtc",
      direction: message.direction === "sent" ? "sent" : "received",
      stream: text(message.label) || "datachannel",
      url: text(message.url),
      data: message.data,
      binary: message.binary === true,
    };
  } catch {
    return undefined;
  }
}

/** Turns one debugger event into a frame, or notes stream bookkeeping. */
export function streamEvent(tabId: number, method: string, params: Params): void {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const id = text(params.requestId);
  if (method === "Network.webSocketCreated") {
    entry.urls.set(id, text(params.url));
    entry.open.add(id);
  } else if (method === "Network.requestWillBeSent" && params.type === "EventSource")
    entry.urls.set(id, text((params.request as Params | undefined)?.url));
  else if (method === "Network.webSocketClosed") entry.open.delete(id);
  else if (method === "Network.webSocketFrameReceived")
    recordFrame(tabId, wsFrame(entry, params, "received"));
  else if (method === "Network.webSocketFrameSent")
    recordFrame(tabId, wsFrame(entry, params, "sent"));
  else if (method === "Network.eventSourceMessageReceived")
    recordFrame(tabId, {
      kind: "sse",
      direction: "received",
      stream: id,
      url: entry.urls.get(id) ?? "",
      data: params.data,
      event: text(params.eventName) || "message",
    });
  else if (method === "Runtime.bindingCalled") {
    const frame = rtcFrame(params);
    if (frame && entry.webrtc !== undefined) recordFrame(tabId, frame);
  }
}

// Wraps RTCDataChannel send and message delivery in the page; reports through the binding.
function rtcTapSource(): string {
  return `(() => {
  if (!window.RTCDataChannel || window.__aeonRtcTapped) return;
  window.__aeonRtcTapped = true;
  const tell = (channel, direction, data) => {
    try {
      const binary = typeof data !== 'string';
      const fn = window[${JSON.stringify(RTC_BINDING)}];
      if (fn) fn(JSON.stringify({direction, label: channel.label, url: location.origin + '#datachannel:' + channel.label, binary, data: binary ? '' : data.slice(0, 8192)}));
    } catch {}
  };
  const proto = RTCDataChannel.prototype, send = proto.send;
  proto.send = function (data) { tell(this, 'sent', data); return send.apply(this, arguments); };
  const add = proto.addEventListener;
  const seen = new WeakSet();
  const watch = (channel) => { if (seen.has(channel)) return; seen.add(channel); add.call(channel, 'message', (event) => tell(channel, 'received', event.data)); };
  proto.addEventListener = function (type) { if (type === 'message') watch(this); return add.apply(this, arguments); };
  const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  if (desc && desc.set) Object.defineProperty(proto, 'onmessage', {...desc, set(value) { watch(this); desc.set.call(this, value); }});
})();`;
}

async function start(tabId: number, options: Params): Promise<unknown> {
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = { ring: new Ring(), urls: new Map(), descriptors: new Map(), open: new Set() };
    tabs.set(tabId, entry);
    holdBrowserDebugger(tabId, true);
    await send({ tabId }, "Network.enable", undefined, { label: "streams" });
  }
  if (options.webrtc === true && entry.webrtc === undefined) {
    entry.webrtc = "";
    entry.webrtc = await installTap(tabId, RTC_BINDING, rtcTapSource());
  }
  return { streaming: true, webrtc: entry.webrtc !== undefined, frames: entry.ring.items.length };
}

/** Ends the tap: waiters get null, the page script and binding go, the debugger is released. */
export async function stopStreams(tabId: number): Promise<{ stopped: boolean }> {
  const entry = tabs.get(tabId);
  if (!entry) return { stopped: false };
  tabs.delete(tabId);
  entry.ring.close();
  // Network stays on: the tab's actions and page.network share that domain.
  if (entry.webrtc !== undefined) await removeTap(tabId, RTC_BINDING, entry.webrtc);
  holdBrowserDebugger(tabId, false);
  return { stopped: true };
}

function descriptors(entry: TabStreams): unknown[] {
  return [...entry.descriptors.values()].map((found) => ({
    url: found.url,
    protocol: found.kind,
    direction: [...found.directions].join("+"),
    formats: [...found.formats],
    ...(found.events.size ? { events: [...found.events].slice(0, 20) } : {}),
    schema: Object.fromEntries(
      Object.entries(found.schema).map(([path, types]) => [path, [...types].join("|")]),
    ),
    samples: found.samples,
  }));
}

export async function streamsCall(tabId: number, action: string, options: Params) {
  if (action === "start") return start(tabId, options);
  if (action === "stop") return stopStreams(tabId);
  if (action === "state")
    return { streaming: tabs.has(tabId), frames: tabs.get(tabId)?.ring.items.length ?? 0 };
  const entry = tabs.get(tabId);
  if (action === "waitFor") {
    const ready = entry ?? (await start(tabId, options), tabs.get(tabId));
    return ready ? ready.ring.waitFor(readFilter(options), waitMs(options)) : null;
  }
  if (!entry) throw new Error("Not streaming: call page.streams.start() first");
  if (action === "list") return entry.ring.list(readFilter(options), Number(options.limit) || 200);
  if (action === "describe") return descriptors(entry);
  if (action === "clear") {
    entry.ring.items.length = 0;
    entry.descriptors.clear();
    return { cleared: true };
  }
  throw new Error("UNSUPPORTED: page.streams." + action);
}

/** Exported for tests: a tab created without Chrome (no CDP). */
export function streamsTabForTest(tabId: number): void {
  tabs.set(tabId, { ring: new Ring(), urls: new Map(), descriptors: new Map(), open: new Set() });
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== undefined && tabs.has(source.tabId) && !source.sessionId)
      streamEvent(source.tabId, method, (params ?? {}) as Params);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabs.get(tabId)?.ring.close();
    tabs.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    tabs.get(source.tabId)?.ring.close();
    tabs.delete(source.tabId);
  });
});
