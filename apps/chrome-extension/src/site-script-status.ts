import { SCRIPT_KEY, readScripts } from "./site-script-records.js";

export async function inspectSiteScript(tabId: number, scriptId?: string): Promise<unknown> {
  if (!scriptId) throw new Error("Provide scriptId for status.");
  const stored = await chrome.storage.local.get([SCRIPT_KEY, "aeon-site-script-errors"]);
  const saved = readScripts(stored[SCRIPT_KEY]).find((script) => script.scriptId === scriptId);
  const tab = await chrome.tabs.get(tabId);
  try {
    const registered = await chrome.userScripts.getScripts({ ids: ["aeon-site-" + scriptId] });
    const results = await chrome.userScripts.execute({
      target: { tabId },
      world: "USER_SCRIPT",
      worldId: "aeon-site-" + scriptId,
      js: [
        {
          code: `(() => {const s = globalThis.__aeonSiteScript; return s ? {revision:s.revision,
        completed:s.completed === true, failed:s.failed, error:s.error, startedAt:s.startedAt,
        url:location.href, value:s.value} : {executed:false,url:location.href};})()`,
        },
      ],
    });
    const first = results[0];
    return {
      saved: Boolean(saved),
      enabled: saved?.enabled ?? false,
      registered: registered.length > 0,
      url: tab.url,
      execution: first?.result ?? null,
      error: first?.error ? String(first.error) : undefined,
      lastError:
        (stored["aeon-site-script-errors"] as Record<string, unknown> | undefined)?.[scriptId] ??
        null,
    };
  } catch (error) {
    return { saved: Boolean(saved), url: tab.url, error: String(error) };
  }
}
