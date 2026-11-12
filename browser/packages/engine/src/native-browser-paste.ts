import { BrowserActionError } from "./native-browser-common.js";
import { onNode, fillTextNode } from "./native-browser-dom.js";
import { toOffscreen } from "./code-offscreen-host.js";
import { send } from "./cdp/send.js";

// Paste is its own file: the clipboard swap runs in the offscreen document, the page fallback
// writes through navigator.clipboard, and the value only counts once the editor shows it.
export async function pasteNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  text: string,
  html: string,
): Promise<void> {
  await send(debuggee, "Page.bringToFront", undefined, { label: "pasteNode" }).catch(
    () => undefined,
  );
  const swap = (await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "clipboardSwap",
    text,
    html,
  }).catch((error: unknown) => ({ error: String(error) }))) as { error?: string } | undefined;
  let backup: string | undefined;
  let pageWritten = false;
  if (swap?.error) {
    backup = await pageClipboard(debuggee, "read");
    pageWritten = Boolean(await pageClipboard(debuggee, "write", text, html));
    if (!pageWritten) throw new BrowserActionError("CLIPBOARD_UNAVAILABLE", swap.error);
  }
  try {
    await onNode(debuggee, id, function (this: HTMLElement) {
      this.focus();
    });
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await send(
        debuggee,
        "Input.dispatchKeyEvent",
        {
          type,
          key: "v",
          code: "KeyV",
          modifiers: 2,
          windowsVirtualKeyCode: 86,
          ...(type === "rawKeyDown" ? { commands: ["paste"] } : {}),
        },
        { label: "pasteNode" },
      );
    }
    await new Promise((done) => setTimeout(done, 30));
    const landed = await onNode<string>(debuggee, id, function (this: HTMLElement) {
      return this.innerHTML || this.innerText || "";
    });
    if (!landed || (!landed.includes(text.slice(0, 20)) && !/text/i.test(landed)))
      await fillTextNode(debuggee, id, text);
  } finally {
    if (pageWritten) await pageClipboard(debuggee, "restore", backup ?? "");
    else
      await toOffscreen({ target: "aeon-code-offscreen", kind: "clipboardRestore" }).catch(
        () => undefined,
      );
  }
}

async function pageClipboard(
  debuggee: chrome.debugger.Debuggee,
  action: string,
  text = "",
  html = "",
): Promise<string | undefined> {
  const expression =
    action === "read"
      ? "navigator.clipboard.readText().catch(()=> '')"
      : action === "restore"
        ? `navigator.clipboard.writeText(${JSON.stringify(text)}).then(()=> 'ok',()=> 'fail')`
        : `navigator.clipboard.write([new ClipboardItem({"text/plain": new Blob([${JSON.stringify(text)}],{type:"text/plain"}), "text/html": new Blob([${JSON.stringify(html)}],{type:"text/html"})})]).then(()=> 'ok',()=> 'fail')`;
  const result = (await send(
    debuggee,
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { label: "pageClipboard", ms: 5_000 },
  ).catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
  if (action === "read") return String(result?.result?.value ?? "");
  return result?.result?.value === "ok" ? "ok" : undefined;
}
