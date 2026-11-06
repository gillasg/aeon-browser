// Waits on the user (an ask_user question, a browser hand-off) end the moment the user acts in the
// chat: a stop aborts the tool's signal, and a steer ends every wait open in that chat, so the
// message reaches the model now instead of after the wait times out.

const open = new Map<string, Set<AbortController>>();

export const STEERED_NOTE =
  "The user sent a message instead of answering: read it and follow it; do not ask again.";

export interface UserWait {
  /** Aborts on a stop (the tool's own signal) or on a steer in the same chat. */
  signal: AbortSignal;
  /** True when the wait ended because the user steered. */
  steered: () => boolean;
  /** Always call when the wait is over. */
  close: () => void;
}

/**
 * `gate`, when given, says whether a steer ends the wait right now (a browser cell ends only while
 * it is handing off to the user; otherwise the steer waits for the cell, as before).
 */
export function openUserWait(
  chatId: string,
  signal?: AbortSignal,
  gate: () => boolean = () => true,
): UserWait {
  const controller = new AbortController();
  let steered = false;
  const stop = () => controller.abort(signal?.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const waits = open.get(chatId) ?? new Set<AbortController>();
  open.set(chatId, waits);
  const entry = Object.assign(controller, {
    steer: () => {
      if (!gate()) return false;
      steered = true;
      controller.abort("steered");
      return true;
    },
  });
  waits.add(entry);
  return {
    signal: controller.signal,
    steered: () => steered,
    close: () => {
      signal?.removeEventListener("abort", stop);
      waits.delete(entry);
      if (!waits.size) open.delete(chatId);
    },
  };
}

/** The user steered the chat: end every wait open in it. Returns how many ended. */
export function endUserWaits(chatId: string): number {
  let ended = 0;
  for (const wait of [...(open.get(chatId) ?? [])])
    if ((wait as AbortController & { steer: () => boolean }).steer()) ended++;
  return ended;
}

/** Resolves `promise`, or `fallback()` once `signal` aborts, whichever comes first. */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  fallback: () => T,
): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(fallback());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
