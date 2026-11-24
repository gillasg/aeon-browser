import { recordingMessage } from "./code-offscreen-recorder.js";
import { parseGoogleResults } from "./google-results.js";

// The offscreen document does only what needs a document: tab recording (MediaRecorder), the
// clipboard swap a paste uses, and HTML parsing with the browser's own parser. browser_code
// realms run in the local Aeon process, never here: the extension evaluates no code.

let clipboardBackup: { text: string; html: string } | undefined;
let clipboardBusy = false;
async function clipboardSwap(text: string, html: string): Promise<Record<string, unknown>> {
  if (clipboardBusy) return { error: "CLIPBOARD_BUSY" };
  clipboardBusy = true;
  try {
    clipboardBackup = { text: await navigator.clipboard.readText().catch(() => ""), html: "" };
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    return { ok: true };
  } catch (error) {
    clipboardBackup = undefined;
    return { error: String(error) };
  }
}
async function clipboardRestore(): Promise<Record<string, unknown>> {
  try {
    if (clipboardBackup)
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([clipboardBackup.text], { type: "text/plain" }),
        }),
      ]);
    return { ok: true };
  } catch (error) {
    return { error: String(error) };
  } finally {
    clipboardBackup = undefined;
    clipboardBusy = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-offscreen" || sender.id !== chrome.runtime.id) return;
  if (message.kind === "ping") {
    reply({ ok: true });
    return;
  }
  if (message.kind === "clipboardSwap") {
    void clipboardSwap(String(message.text ?? ""), String(message.html ?? "")).then(reply);
    return true;
  }
  if (message.kind === "clipboardRestore") {
    void clipboardRestore().then(reply);
    return true;
  }
  if (message.kind === "parseGoogle") {
    try {
      reply({
        results: parseGoogleResults(String(message.html ?? ""), Number(message.limit) || 10),
      });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const recorded = recordingMessage(message);
  if (recorded) {
    void recorded.then(reply, (error: unknown) => reply({ ok: false, error: String(error) }));
    return true;
  }
});
