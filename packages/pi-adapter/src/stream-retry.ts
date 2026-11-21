import type { AgentSession } from "@earendil-works/pi-coding-agent";

// Pi retries stopReason "error" only, and skips that retry when the run was aborted. A dropped
// provider stream arrives here as stopReason "aborted", so the retry has to finish inside the
// stream call, on a fresh signal, before the agent loop records it as the chat's answer.

type ModelStream = AgentSession["agent"]["streamFunction"];
type StreamArgs = Parameters<ModelStream>;
type StreamResult = Awaited<ReturnType<ModelStream>>;

export interface StreamRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface AttemptMessage {
  stopReason?: string;
  errorMessage?: string;
}

interface Attempt {
  events: unknown[];
  message: AttemptMessage;
}

interface RetrySlot {
  fn: ModelStream;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

const slots = new WeakMap<ModelStream, RetrySlot>();
const intentional = new WeakSet<object>();
const activeSignals = new WeakMap<object, AbortSignal>();

const NON_RETRYABLE =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|"code"\s*:\s*"?1308(?![0-9])/i;

// Same transient shapes pi-ai retries for stopReason "error". Kept here because that helper
// returns false for an aborted message, which is the case this wrapper exists to cover.
const TRANSIENT =
  /overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|provider.?returned.?(?:an.?)?error|exceeded request buffer limit while retrying upstream|unable to forward upstream|upstream.?request.?failed|upstream_stream_read_error|stream was interrupted|http\/?2 stream failed|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|request to \S+ failed, reason:|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|stream disconnected before completion|cut short after the reply had begun|pending stream has been canceled|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted|subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/i;

const USER_ABORT = /request was aborted|operation was aborted/i;

interface Released {
  aborted: boolean;
  listeners: Array<{ listener: EventListenerOrEventListenerObject; once: boolean }>;
}

const released = new WeakMap<AbortSignal, Released>();

/** The loop's signal was aborted by a dropped stream. Tools keep going until a real stop. */
export function releaseLoopSignal(signal: AbortSignal): void {
  const existing = released.get(signal);
  if (existing) {
    existing.aborted = false;
    return;
  }
  const state: Released = { aborted: false, listeners: [] };
  released.set(signal, state);
  try {
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => state.aborted,
    });
  } catch {
    released.delete(signal);
    return;
  }
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type !== "abort") return originalAdd(type, listener, options);
    const once = typeof options === "boolean" ? options : Boolean(options?.once);
    if (state.aborted) {
      invoke(listener);
      return;
    }
    state.listeners.push({ listener, once });
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type !== "abort") return originalRemove(type, listener, options);
    state.listeners = state.listeners.filter((item) => item.listener !== listener);
  }) as typeof signal.removeEventListener;
}

/** A real stop (the user, a loop, a budget). Tools see the signal as aborted again. */
export function honorAbort(signal: AbortSignal): void {
  const state = released.get(signal);
  if (!state || state.aborted) return;
  state.aborted = true;
  const pending = state.listeners.splice(0);
  for (const item of pending) invoke(item.listener);
}

function invoke(listener: EventListenerOrEventListenerObject): void {
  const event = new Event("abort");
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

/** Call before session.abort() so a dropped stream is not retried and tools still stop. */
export function markRunAborted(session: object): void {
  intentional.add(session);
  const signal = activeSignals.get(session);
  if (signal) honorAbort(signal);
}

export function streamRetrySlot(fn: ModelStream | undefined): RetrySlot | undefined {
  return fn ? slots.get(fn) : undefined;
}

export function installStreamRetry(session: AgentSession, options: StreamRetryOptions = {}): void {
  const agent = session.agent;
  const current = agent?.streamFunction;
  if (!agent || !current || slots.has(current)) return;
  const slot: RetrySlot = { fn: current };
  const wrapped: ModelStream = (model, context, streamOptions) =>
    retryStream(session, agent, () => slot.fn, model, context, streamOptions, options);
  slots.set(wrapped, slot);
  agent.streamFunction = wrapped;
}

interface RetryState {
  sawAborted: boolean;
  didRelease: boolean;
}

function openRetry(session: object, given: AbortSignal | undefined): RetryState {
  if (given && !given.aborted) intentional.delete(session);
  if (given) activeSignals.set(session, given);
  return { sawAborted: Boolean(given?.aborted), didRelease: false };
}

async function retryStream(
  session: object,
  agent: AgentSession["agent"],
  inner: () => ModelStream,
  model: StreamArgs[0],
  context: StreamArgs[1],
  streamOptions: StreamArgs[2],
  options: StreamRetryOptions,
): Promise<StreamResult> {
  const given = streamOptions?.signal;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const state = openRetry(session, given);
  let last: Attempt | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const step = await nextAttempt(
      session,
      agent,
      inner,
      model,
      context,
      streamOptions,
      given,
      state,
      attempt,
      maxRetries,
      options,
    );
    if (step.last) last = step.last;
    if (!step.again) break;
  }
  return finishRetry(last, state, given, session);
}

async function nextAttempt(
  session: object,
  agent: AgentSession["agent"],
  inner: () => ModelStream,
  model: StreamArgs[0],
  context: StreamArgs[1],
  streamOptions: StreamArgs[2],
  given: AbortSignal | undefined,
  state: RetryState,
  attempt: number,
  maxRetries: number,
  options: StreamRetryOptions,
): Promise<{ last?: Attempt; again: boolean }> {
  if (intentional.has(session)) return { again: false };
  const signal = attemptSignal(attempt, given);
  if (signal === "stopped") return { again: false };
  const last = await takeAttempt(
    inner(),
    agent,
    model,
    context,
    streamOptions,
    signal,
    given,
    state,
    session,
  );
  if (!transientAborted(last.message, state.sawAborted, session) || attempt === maxRetries) {
    return { last, again: false };
  }
  releaseOnce(given, state);
  return { last, again: await pauseBeforeRetry(options, attempt, given) };
}

function attemptSignal(
  attempt: number,
  given: AbortSignal | undefined,
): AbortSignal | undefined | "stopped" {
  if (attempt === 0) return given;
  const controller = new AbortController();
  if (!given) return controller.signal;
  given.addEventListener("abort", () => controller.abort(), { once: true });
  if (given.aborted) controller.abort();
  return controller.signal.aborted ? "stopped" : controller.signal;
}

async function takeAttempt(
  fn: ModelStream,
  agent: AgentSession["agent"],
  model: StreamArgs[0],
  context: StreamArgs[1],
  streamOptions: StreamArgs[2],
  signal: AbortSignal | undefined,
  given: AbortSignal | undefined,
  state: RetryState,
  session: object,
): Promise<Attempt> {
  try {
    const last = await oneAttempt(fn, agent, model, context, streamOptions, signal);
    noteAbort(given, state);
    return last;
  } catch (error) {
    noteAbort(given, state);
    const text = error instanceof Error ? error.message : String(error);
    const message = { stopReason: "aborted", errorMessage: text };
    if (!transientAborted(message, state.sawAborted, session)) throw error;
    return { events: [], message };
  }
}

function noteAbort(given: AbortSignal | undefined, state: RetryState): void {
  if (given?.aborted) state.sawAborted = true;
}

function releaseOnce(given: AbortSignal | undefined, state: RetryState): void {
  if (!given?.aborted || state.didRelease) return;
  releaseLoopSignal(given);
  state.didRelease = true;
  state.sawAborted = true;
}

async function pauseBeforeRetry(
  options: StreamRetryOptions,
  attempt: number,
  given: AbortSignal | undefined,
): Promise<boolean> {
  const baseDelay = options.baseDelayMs ?? BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  try {
    await sleep(Math.min(MAX_DELAY_MS, baseDelay * 2 ** attempt), given);
    return true;
  } catch {
    return false;
  }
}

function finishRetry(
  last: Attempt | undefined,
  state: RetryState,
  given: AbortSignal | undefined,
  session: object,
): StreamResult {
  if (!last) return replay([], { stopReason: "aborted", errorMessage: "Request was aborted" });
  if (state.didRelease && given && transientAborted(last.message, true, session)) honorAbort(given);
  return replay(last.events, last.message);
}

async function oneAttempt(
  inner: ModelStream,
  agent: AgentSession["agent"],
  model: StreamArgs[0],
  context: StreamArgs[1],
  streamOptions: StreamArgs[2],
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  const stream = await inner.call(
    agent,
    model,
    context,
    signal ? { ...streamOptions, signal } : streamOptions,
  );
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  const message = (await stream.result()) as AttemptMessage;
  return { events, message: message ?? {} };
}

function transientAborted(message: AttemptMessage, sawAborted: boolean, session: object): boolean {
  if (!sawAborted || intentional.has(session)) return false;
  if (message.stopReason !== "aborted") return false;
  const text = message.errorMessage ?? "";
  if (!text || USER_ABORT.test(text) || NON_RETRYABLE.test(text)) return false;
  return TRANSIENT.test(text);
}

function replay(events: unknown[], message: AttemptMessage): StreamResult {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: () => Promise.resolve(message),
  };
  return stream as unknown as StreamResult;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
