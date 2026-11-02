import type { BrowserStep } from "@browserkit/protocol";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";

// Agent code never runs in a page that holds, or has held, a password the agent did not type
// itself: a password-manager sign-in or a person typing one. Reading a password field is plain
// JavaScript, so hiding values from results is not enough on its own; the page is closed to the
// agent's code instead. The mark lives in the extension's own isolated world, where page scripts
// and agent code cannot reach it, and goes with the document: a reload or navigation opens the
// page again. A sign-in reloads the page first when agent code ran in it (removing any script
// it planted for new documents), and reloads it after signing in when the page stayed the same,
// so nothing the page kept in memory outlives the sign-in.

const typed = new Map<number, Set<string>>();
const planted = new Map<number, Set<string>>();
/** DevTools calls that read nothing from the page: a screenshot shows a password as dots. */
const LEAVES_PAGE_ALONE = new Set([
  "Page.captureScreenshot",
  "Page.reload",
  "Page.navigate",
  "Page.stopLoading",
]);
const READ_ONLY_FRAME_ACTIONS = new Set(["list", "click", "fill", "snapshot"]);

export const PASSWORD_PAGE =
  "PASSWORD_PAGE: a password was typed in this page, so code cannot run in it; carry on with clicks, or reload it (page.reload()) to read it again";

/** Steps that run the agent's own code (or raw DevTools commands) inside the page. */
export function runsPageCode(step: BrowserStep): boolean {
  if (["evaluate", "waitFor", "siteScript", "event"].includes(step.op)) return true;
  if (step.op === "cdp") return !LEAVES_PAGE_ALONE.has(step.method);
  if (step.op === "frames") return !READ_ONLY_FRAME_ACTIONS.has(step.action);
  return false;
}

/** Text the agent typed itself is no secret from it: a password it chose for a new account. */
export function noteAgentText(step: BrowserStep): void {
  const text =
    step.op === "fill"
      ? step.value
      : step.op === "paste"
        ? step.text
        : step.op === "keys"
          ? step.keys
          : step.op === "frames" && step.action === "fill"
            ? step.value
            : undefined;
  if (!text || !("target" in step)) return;
  const values = typed.get(step.target.tabId) ?? new Set<string>();
  values.add(text);
  typed.set(step.target.tabId, values);
}

/** A script the agent registered to run on every new document of this tab. */
export function notePlantedScript(tabId: number, result: unknown): void {
  const id = (result as { identifier?: unknown } | undefined)?.identifier;
  if (typeof id !== "string") return;
  const ids = planted.get(tabId) ?? new Set<string>();
  ids.add(id);
  planted.set(tabId, ids);
}

export function forgetPasswordLock(tabId: number): void {
  typed.delete(tabId);
  planted.delete(tabId);
}
onEngineInstall(() => chrome.tabs.onRemoved.addListener(forgetPasswordLock));

// Runs in every frame, in the extension's isolated world. Marks the document when a password
// field holds a value the agent did not type (or when told to), and says whether agent code ran.
function probe(
  known: string[],
  mark: boolean,
  agent: boolean,
): { password: boolean; agent: boolean } {
  const page = window as unknown as Record<string, boolean | undefined>;
  const dom = (globalThis as { chrome?: { dom?: typeof chrome.dom } }).chrome?.dom;
  const shadowOf = (el: Element) => {
    if (!(el instanceof HTMLElement)) return el.shadowRoot;
    try {
      return (dom?.openOrClosedShadowRoot?.(el) as ShadowRoot | null) ?? el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  };
  const filled = (root: Document | ShadowRoot): boolean => {
    for (const input of root.querySelectorAll("input"))
      if (input.type === "password" && input.value && !known.includes(input.value)) return true;
    for (const el of root.querySelectorAll("*")) {
      const shadow = shadowOf(el);
      if (shadow && filled(shadow)) return true;
    }
    return false;
  };
  if (mark || filled(document)) page.__aeonPasswordPage = true;
  const ran = page.__aeonAgentCode === true;
  if (agent) page.__aeonAgentCode = true;
  return { password: page.__aeonPasswordPage === true, agent: ran };
}

async function probeTab(
  tabId: number,
  options: { mark?: boolean; agent?: boolean },
): Promise<{ password: boolean; agent: boolean }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    func: probe,
    args: [[...(typed.get(tabId) ?? [])], options.mark ?? false, options.agent ?? false],
  });
  // The top page must answer; a frame the probe could not run in has nothing it could read.
  const top = results.find((item) => item.frameId === 0);
  if (!top?.result) {
    const reason = (top as { error?: unknown } | undefined)?.error;
    throw new Error(top ? `the check failed in the page: ${String(reason)}` : "no top frame");
  }
  const states = results.flatMap((item) =>
    item.result ? [item.result as { password: boolean; agent: boolean }] : [],
  );
  return {
    password: states.some((state) => state.password),
    agent: states.some((state) => state.agent),
  };
}

/** Refuses a step that would run code in a page that has held a password. */
export async function guardPageCode(step: BrowserStep): Promise<void> {
  if (!runsPageCode(step) || !("target" in step)) return;
  let state: { password: boolean };
  try {
    state = await probeTab(step.target.tabId, { agent: true });
  } catch (error) {
    // A page Aeon cannot check is treated as holding a password.
    throw new Error(
      `PASSWORD_PAGE: could not check this page for a typed password, so code cannot run in it (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (state.password) throw new Error(PASSWORD_PAGE);
}

async function reload(tabId: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.webNavigation.onDOMContentLoaded.removeListener(ready);
      resolve();
    };
    const ready = (event: { tabId: number; frameId: number }) => {
      if (event.tabId === tabId && event.frameId === 0) done();
    };
    const timer = setTimeout(done, 15_000);
    chrome.webNavigation.onDOMContentLoaded.addListener(ready);
    chrome.tabs.reload(tabId).catch(done);
  });
}

async function removePlanted(tabId: number): Promise<void> {
  const ids = planted.get(tabId);
  if (!ids?.size) return;
  await withBrowserDebugger(tabId, async (debuggee) => {
    for (const identifier of ids)
      await chrome.debugger
        .sendCommand(debuggee, "Page.removeScriptToEvaluateOnNewDocument", { identifier })
        .catch(() => undefined);
  });
  planted.delete(tabId);
}

function patternMatches(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):/i.test(url);
  const parts = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!parts) return false;
  const [, scheme = "*", host = "", path = "/*"] = parts;
  const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const hostSource =
    host === "*"
      ? "[^/]*"
      : host.startsWith("*.")
        ? `(?:[^/]*\\.)?${escape(host.slice(2))}`
        : escape(host);
  const schemeSource = scheme === "*" ? "https?" : escape(scheme);
  const pathSource = path.split("*").map(escape).join(".*");
  return new RegExp(`^${schemeSource}:\\/\\/${hostSource}(?::\\d+)?${pathSource}$`, "i").test(url);
}

/** Scripts registered to run on this page (boosts, site scripts): any could read the field. */
async function pageScripts(url: string): Promise<string[]> {
  const api = (globalThis as { chrome?: { userScripts?: typeof chrome.userScripts } }).chrome
    ?.userScripts;
  const scripts = await api?.getScripts().catch(() => []);
  return (scripts ?? [])
    .filter(
      (script) =>
        (script.matches ?? []).some((pattern) => patternMatches(pattern, url)) &&
        !(script.excludeMatches ?? []).some((pattern) => patternMatches(pattern, url)),
    )
    .map((script) => script.id);
}

/**
 * Before a sign-in types anything: refuses while page scripts run on the page (their ids are
 * returned), reloads the page when agent code ran in it, then marks it as a password page.
 */
export async function prepareSignIn(tabId: number, url: string): Promise<string[] | undefined> {
  const scripts = await pageScripts(url);
  if (scripts.length) return scripts;
  const state = await probeTab(tabId, {}).catch(() => ({ password: false, agent: true }));
  if (state.agent || planted.get(tabId)?.size) {
    await removePlanted(tabId);
    await reload(tabId);
  }
  await probeTab(tabId, { mark: true });
  return undefined;
}

/** After signing in: a page that is still the same document is reloaded, clearing its memory. */
export async function finishSignIn(tabId: number): Promise<void> {
  const state = await probeTab(tabId, {}).catch(() => ({ password: true, agent: false }));
  if (state.password) await reload(tabId);
}
