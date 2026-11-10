import type { BrowserStep } from "@browserkit/protocol";
import { BrowserActionError } from "./native-browser-common.js";
import { send } from "./cdp/send.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { SessionMap } from "./native-session-map.js";

// Agent code never runs in a page that holds, or has held, a password the agent did not type
// itself: a password-manager sign-in or a person typing one. Reading a password field is plain
// JavaScript, so hiding values from results is not enough on its own; the page is closed to the
// agent's code instead. The mark lives in the extension's own isolated world, where page scripts
// and agent code cannot reach it, and goes with the document: a reload or navigation opens the
// page again. A sign-in reloads the page first when agent code ran in it (removing any script
// it planted for new documents), and reloads it after signing in when the page stayed the same,
// so nothing the page kept in memory outlives the sign-in.

// Kept across service worker restarts: forgetting them locked the agent out of its own sign-up.
const typed = new SessionMap<Set<string>>(
  "aeon-agent-typed",
  (values) => [...values],
  (values) => new Set(Array.isArray(values) ? values.map(String) : []),
);
const planted = new SessionMap<Set<string>>(
  "aeon-planted-scripts",
  (ids) => [...ids],
  (ids) => new Set(Array.isArray(ids) ? ids.map(String) : []),
);
/** DevTools calls that read nothing from the page: a screenshot shows a password as dots. */
const LEAVES_PAGE_ALONE = new Set([
  "Page.captureScreenshot",
  "Page.reload",
  "Page.navigate",
  "Page.stopLoading",
]);
const READ_ONLY_FRAME_ACTIONS = new Set(["list", "click", "fill", "snapshot"]);

export const PASSWORD_PAGE =
  "PASSWORD_PAGE: this page holds a password your code did not type (bu.signIn, Chrome's autofill or the user filled it), so code cannot run in it; carry on with clicks, or reload it (page.reload()) to read it again";

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

/**
 * Whether the agent typed this value into the tab itself, in one step or across several
 * (keyboard.type, pressSequentially, a fill): a password it chose for a new account.
 */
export function agentTyped(tabId: number, value: string): boolean {
  const values = [...(typed.get(tabId) ?? [])];
  return values.includes(value) || values.join("").includes(value);
}

/** Whether the agent typed anything into the tab: only then can a click submit its password. */
export function agentTypedIn(tabId: number): boolean {
  return (typed.get(tabId)?.size ?? 0) > 0;
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
): { password: boolean; agent: boolean; filled: boolean } {
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
  const filledNow = filled(document);
  if (mark || filledNow) page.__aeonPasswordPage = true;
  const ran = page.__aeonAgentCode === true;
  if (agent) page.__aeonAgentCode = true;
  return { password: page.__aeonPasswordPage === true, agent: ran, filled: filledNow };
}

// executeScript over all frames answers only once every frame has run, so one stuck frame (an ad or
// tracker iframe in a busy renderer) held every page command for a minute. All frames get a short
// bound; past it, each frame is probed on its own and a frame from another site that still does not
// answer is skipped: code in the top page could not read its fields anyway.
const PROBE_MS = 2500;
interface ProbeState {
  password: boolean;
  agent: boolean;
  filled: boolean;
}
type ProbeResult = chrome.scripting.InjectionResult<ProbeState>;

function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  return Promise.race([work, new Promise<undefined>((done) => setTimeout(done, ms, undefined))]);
}

async function probeFrames(
  tabId: number,
  options: { mark?: boolean; agent?: boolean },
): Promise<ProbeResult[]> {
  const run = (target: chrome.scripting.InjectionTarget) =>
    chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: probe,
      args: [[...(typed.get(tabId) ?? [])], options.mark ?? false, options.agent ?? false],
    }) as Promise<ProbeResult[]>;
  const all = await within(PROBE_MS, run({ tabId, allFrames: true }));
  if (all) return all;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const top = frames.find((frame) => frame.frameId === 0);
  const origin = (url: string | undefined) => {
    try {
      return new URL(url ?? "").origin;
    } catch {
      return "";
    }
  };
  const answers = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      result: await within(
        PROBE_MS,
        run({ tabId, frameIds: [frame.frameId] }).then(
          (items) => items[0],
          (error: unknown) => ({ frameId: frame.frameId, error }) as unknown as ProbeResult,
        ),
      ),
    })),
  );
  const silent = answers.filter(
    (item) =>
      !item.result && (item.frame.frameId === 0 || origin(item.frame.url) === origin(top?.url)),
  );
  if (silent.length)
    throw new Error(`the page did not answer the check within ${(2 * PROBE_MS) / 1000} s`);
  return answers.flatMap((item) => (item.result ? [item.result] : []));
}

async function probeTab(
  tabId: number,
  options: { mark?: boolean; agent?: boolean },
): Promise<ProbeState> {
  const results = await probeFrames(tabId, options);
  // The top page must answer; a frame the probe could not run in has nothing it could read.
  const top = results.find((item) => item.frameId === 0);
  if (!top?.result) {
    const reason = (top as { error?: unknown } | undefined)?.error;
    throw new Error(top ? `the check failed in the page: ${String(reason)}` : "no top frame");
  }
  const states = results.flatMap((item) => (item.result ? [item.result as ProbeState] : []));
  return {
    password: states.some((state) => state.password),
    agent: states.some((state) => state.agent),
    filled: states.some((state) => state.filled),
  };
}

/**
 * Refuses a step that would run code in a page that has held a password. Once no field holds
 * one any more (the sign-in went through, often without a new document), the page is reloaded,
 * which clears what it kept in memory, and the step runs: the agent is never left blind.
 */
export async function guardPageCode(step: BrowserStep): Promise<void> {
  if (!runsPageCode(step) || !("target" in step)) return;
  const tabId = step.target.tabId;
  await typed.ready;
  const state = await checkedProbe(tabId);
  if (!state.password) return;
  if (!state.filled) {
    await reload(tabId);
    if (!(await checkedProbe(tabId)).password) return;
  }
  throw new Error(PASSWORD_PAGE);
}

/** Chrome's answer when the page's document went away mid-check (it navigated, reloaded or was discarded). */
export function documentReplaced(message: string): boolean {
  return /frame with id \d+ was removed|frame was removed|no top frame|no frame with id/i.test(
    message,
  );
}

/**
 * The probe, once more after a moment when the page was being replaced. A page Aeon still
 * cannot check runs no code either way; only the reason differs.
 */
async function checkedProbe(tabId: number): Promise<{ password: boolean; filled: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await probeTab(tabId, { agent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/did not answer the check/.test(message))
        throw new BrowserActionError(
          "TIMEOUT",
          `The page did not answer within ${(2 * PROBE_MS) / 1000} s (a busy page, or a background tab Chrome paused), so no code ran in it; the cell is still running: try again, or bring the tab to the front.`,
        );
      const replaced = documentReplaced(message);
      if (replaced && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw new Error(
        replaced
          ? `TARGET_LOST: the page was being replaced (it navigated, reloaded or was discarded), so no code ran in it; wait for it to load (page.waitForLoadState()) and try again (${message})`
          : `PASSWORD_PAGE: could not check this page for a typed password, so code cannot run in it (${message})`,
      );
    }
  }
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
      await send(
        debuggee,
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier },
        { label: "removePlanted" },
      ).catch(() => undefined);
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
  const state = await probeTab(tabId, {}).catch(() => ({
    password: false,
    agent: true,
    filled: false,
  }));
  if (state.agent || planted.get(tabId)?.size) {
    await removePlanted(tabId);
    await reload(tabId);
  }
  await probeTab(tabId, { mark: true });
  return undefined;
}

/** After signing in: a page that is still the same document is reloaded, clearing its memory. */
export async function finishSignIn(tabId: number): Promise<void> {
  const state = await probeTab(tabId, {}).catch(() => ({
    password: true,
    agent: false,
    filled: true,
  }));
  if (state.password) await reload(tabId);
}
