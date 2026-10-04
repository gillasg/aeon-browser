import type { SiteScriptDefinition } from "@pippin/protocol";
import { withBrowserDebugger } from "./native-browser-session.js";
import { siteScriptSource, siteScriptCleanup } from "./site-script-source.js";
const worlds = new Map<string, number>();
export async function previewSiteScript(
  tabId: number,
  script: SiteScriptDefinition,
  assertActive: () => Promise<void>,
): Promise<unknown> {
  return withBrowserDebugger(tabId, async (debuggee) => {
    await assertActive();
    const tree = (await chrome.debugger.sendCommand(debuggee, "Page.getFrameTree")) as {
      frameTree: { frame: { id: string; url: string } };
    };
    const url = tree.frameTree.frame.url;
    if (!script.matches.some((pattern) => matches(pattern, url))) throw new Error("INVALID_TARGET");
    const world = (await chrome.debugger.sendCommand(debuggee, "Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "aeon-preview-" + script.scriptId,
    })) as { executionContextId: number };
    worlds.set(tabId + ":" + script.scriptId, world.executionContextId);
    await assertActive();
    const response = (await boundedPreview(
      chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: siteScriptSource(script),
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      }),
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails)
      return { applied: false, error: response.exceptionDetails.text ?? "Preview failed" };
    return { installed: false, temporary: true, result: response.result?.value ?? null };
  });
}
export async function removeScriptPreview(tabId: number, scriptId: string): Promise<boolean> {
  const key = tabId + ":" + scriptId,
    contextId = worlds.get(key);
  if (contextId === undefined) return false;
  await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: siteScriptCleanup,
      contextId,
      returnByValue: true,
    }),
  ).catch(() => undefined);
  worlds.delete(key);
  return true;
}
function matches(pattern: string, url: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) =>
      Array.from(part, (char) => (/[a-z0-9]/i.test(char) ? char : "\\" + char)).join(""),
    );
  return new RegExp("^" + escaped.join(".*") + "$").test(url);
}
chrome.tabs.onRemoved.addListener((id) => {
  for (const key of worlds.keys()) if (key.startsWith(id + ":")) worlds.delete(key);
});

async function boundedPreview<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Preview exceeded 5 seconds; reload the page if its state is uncertain."),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
