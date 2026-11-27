// The offscreen document records tabs, swaps the clipboard for a paste and parses HTML. It
// outlives the service worker, so a recording keeps going while the worker sleeps.
//
// A message is sent only once the document answers a ping. While it is still loading,
// hasDocument() is already true but its listener is not there yet; the message then reaches only
// other extension pages (chat tabs), which do not answer, and the request came back empty.

export const OFFSCREEN = "code-offscreen.html";
const READY_WAIT_MS = 10_000;
let creating: Promise<void> | undefined;
let ready: Promise<void> | undefined;

async function createOnce(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        chrome.offscreen.Reason.CLIPBOARD,
        chrome.offscreen.Reason.DOM_PARSER,
      ],
      justification:
        "Records tabs the user asks for, swaps the clipboard for a paste, and parses HTML.",
    })
    .catch((error: unknown) => {
      if (!String(error).includes("Only a single offscreen")) throw error;
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

async function answersPing(): Promise<boolean> {
  const reply = (await chrome.runtime
    .sendMessage({ target: "graft-code-offscreen", kind: "ping" })
    .catch(() => undefined)) as { ok?: unknown } | undefined;
  return reply?.ok === true;
}

async function untilReady(): Promise<void> {
  const deadline = Date.now() + READY_WAIT_MS;
  for (;;) {
    await createOnce();
    if (await answersPing()) return;
    if (Date.now() > deadline)
      throw new Error("INTERNAL: the browser code document did not load; runtime reset");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function ensureOffscreen(): Promise<void> {
  // A document that closed since (a reset) needs a fresh check.
  if (ready && !(await chrome.offscreen.hasDocument())) ready = undefined;
  ready ??= untilReady().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  await ready;
}

/** Forget the ready document; call after closing it. */
export function offscreenClosed(): void {
  ready = undefined;
}

export async function toOffscreen(message: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}
