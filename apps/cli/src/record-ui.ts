// `graft record ui <action>`: drive Graft's own surfaces on camera without coordinate hacks. Pages
// open by their real extension URL (home.html?host=panel, home.html?view=…) in one reused tab; the
// cursor is summoned with its real shortcut (Alt+Shift+Space), sent as a trusted OS keystroke to
// the focused Chrome window; the side panel opens the way a person opens it from the cursor box
// (Ctrl+Enter, Cmd+Enter on macOS), since Chrome only opens a side panel on a user gesture.
import { spawnSync } from "node:child_process";
import type { Args } from "browserkit/dist/args.js";
import { graftExtensionId, extensionUrl } from "./extension-url.js";
import type { DaemonHost } from "./host.js";
import { findChromeWindow } from "./record-capture.js";
import { ACTIVE } from "./record-script.js";

export const PAGE_ACTIONS = [
  "home",
  "chat",
  "manage",
  "chats",
  "automations",
  "sites",
  "settings",
  "models",
  "learn",
] as const;
export const UI_ACTIONS = ["cursor", "sidepanel", ...PAGE_ACTIONS, "reload"] as const;
export type UiAction = (typeof UI_ACTIONS)[number];
export type Chord = "cursor" | "panel";

export type UiStep =
  { kind: "page"; url: string } | { kind: "keys"; chords: Chord[] } | { kind: "reload" };

export const UI_USAGE = `Usage: graft record ui ${UI_ACTIONS.join("|")} [--browser <name>] [--display :N] [--out <dir>] [--mark <name>]`;

export function isUiAction(action: string | undefined): action is UiAction {
  return (UI_ACTIONS as readonly string[]).includes(action ?? "");
}

/**
 * The extension page for an action. home and chat are the new-chat canvas, the composer and
 * readiness strip (home.html?host=panel; a bare chat.html needs a chatId); manage is Manage as a
 * tab (home.html, which opens on Sites); the rest are Manage's `?view=` routes (models lands on
 * Settings, learn on Sites).
 */
export function pageUrl(extensionId: string, action: (typeof PAGE_ACTIONS)[number]): string {
  if (action === "home" || action === "chat")
    return extensionUrl(extensionId, "home.html?host=panel");
  if (action === "manage") return extensionUrl(extensionId, "home.html");
  return extensionUrl(extensionId, `home.html?view=${action}`);
}

/**
 * Navigates one tab in place: the active Graft page or blank tab, else any, else the active tab.
 * Other Graft and blank tabs close, so switching pages never piles tabs up. Opening a new tab would
 * put it in the session's tab group, which the camera must never see.
 */
export function pageCode(url: string): string {
  const origin = /^[a-z-]+:\/\/[^/]+\//.exec(url)?.[0] ?? url; // URL#origin is "null" for extensions
  return `const url = ${JSON.stringify(url)};
const tabs = await browser.tabs();
const spare = (t) => [${JSON.stringify(origin)}, "about:blank", "chrome://newtab"].some((p) => String(t.url).startsWith(p));
const tab = tabs.find((t) => t.active && spare(t)) ?? tabs.find(spare) ?? tabs.find((t) => t.active) ?? tabs[0];
if (!tab) throw new Error("No tab is open");
for (const t of tabs) if (t.id !== tab.id && spare(t)) await browser.closeTab(t.id).catch(() => undefined);
// The tab on camera moves by a raw Page.navigate: page.navigate waits for a settled load it cannot
// see on a Graft page, then stops the load mid-way, leaving a blank page. A tab behind others is
// brought forward by page.navigate, which presents it.
if (!tab.active) await browser.page(tab.id).navigate(url);
else if (tab.url !== url) await browser.page(tab.id).cdp("Page.navigate", { url });
return tab.id;`;
}

export function resolveUiAction(action: string | undefined, extensionId: string): UiStep {
  if (!isUiAction(action)) throw new Error(UI_USAGE);
  if (action === "cursor") return { kind: "keys", chords: ["cursor"] };
  if (action === "sidepanel") return { kind: "keys", chords: ["cursor", "panel"] };
  if (action === "reload") return { kind: "reload" };
  return { kind: "page", url: pageUrl(extensionId, action) };
}

export type Command = { cmd: string; args: string[] };

/** The OS command that types one chord into the frontmost Chrome. */
export function chordCommand(chord: Chord, platform: NodeJS.Platform, window?: string): Command {
  if (platform === "darwin") {
    const press =
      chord === "cursor"
        ? "key code 49 using {option down, shift down}"
        : "key code 36 using {command down}";
    return {
      cmd: "osascript",
      args: ["-e", `tell application "System Events" to ${press}`],
    };
  }
  if (platform === "win32") {
    const keys = chord === "cursor" ? "%+ " : "^{ENTER}";
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        `$s = New-Object -ComObject WScript.Shell; [void]$s.AppActivate('Chrome'); $s.SendKeys('${keys}')`,
      ],
    };
  }
  const key = chord === "cursor" ? "alt+shift+space" : "ctrl+Return";
  return {
    cmd: "xdotool",
    args: [...(window ? ["windowfocus", "--sync", window] : []), "key", "--clearmodifiers", key],
  };
}

export type UiDeps = {
  extensionId(): Promise<string>;
  run(code: string): Promise<unknown>;
  exec(command: Command): void;
  chromeWindow(): string | undefined;
  sleep(ms: number): Promise<void>;
  platform: NodeJS.Platform;
};

export async function performUi(action: string | undefined, deps: UiDeps): Promise<UiStep> {
  const step = resolveUiAction(action, isPage(action) ? await deps.extensionId() : "");
  if (step.kind === "page") await deps.run(pageCode(step.url));
  else if (step.kind === "reload")
    await deps.run(`${ACTIVE} await browser.page(tab.id).reload(); return tab.id;`);
  else {
    const window = deps.platform === "linux" ? deps.chromeWindow() : undefined;
    for (const [index, chord] of step.chords.entries()) {
      if (index > 0) await deps.sleep(700); // the cursor box mounts before Ctrl+Enter reaches it
      deps.exec(chordCommand(chord, deps.platform, window));
    }
  }
  return step;
}

function isPage(action: string | undefined): boolean {
  return (PAGE_ACTIONS as readonly string[]).includes(action ?? "");
}

function execOrThrow(command: Command): void {
  const run = spawnSync(command.cmd, command.args, { encoding: "utf8" });
  if (run.error)
    throw new Error(`${command.cmd} is needed to press Graft's shortcut: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${command.cmd} failed: ${(run.stderr ?? "").trim()}`);
}

export function liveUiDeps(host: DaemonHost): UiDeps {
  return {
    extensionId: () => graftExtensionId(),
    run: (code) => host.runInBrowser(code, { session: "graft-record", timeoutMs: 20_000 }),
    exec: execOrThrow,
    chromeWindow: () => {
      try {
        return findChromeWindow();
      } catch {
        return undefined; // no xdotool search match: the key goes to whatever has focus
      }
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    platform: process.platform,
  };
}

/** `graft record ui <action> [--mark <name>]`: the action, then (if recording) a mark at its beat. */
export async function uiCommand(
  args: Args,
  deps: UiDeps,
  markAt: (name: string) => Promise<void>,
  log: (line: string) => void,
): Promise<number> {
  const action = args.positional[1];
  const name = typeof args.flags.mark === "string" ? args.flags.mark : undefined;
  await performUi(action, deps);
  if (name) await markAt(name);
  log(`UI: ${action}`);
  return 0;
}
