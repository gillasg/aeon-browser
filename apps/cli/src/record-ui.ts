// `aeon record ui <action>`: drive Aeon's own surfaces on camera without coordinate hacks. Pages
// open by their real extension URL (home.html?view=…), reused and focused when already open; the
// cursor is summoned with its real shortcut (Alt+Shift+Space), sent as a trusted OS keystroke to
// the focused Chrome window; the side panel opens the way a person opens it from the cursor box
// (Ctrl+Enter, Cmd+Enter on macOS), since Chrome only opens a side panel on a user gesture.
import { spawnSync } from "node:child_process";
import type { Args } from "browserkit/dist/args.js";
import { aeonExtensionId, extensionUrl } from "./extension-url.js";
import type { DaemonHost } from "./host.js";
import { findChromeWindow } from "./record-capture.js";

export const PAGE_ACTIONS = [
  "home",
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

export const UI_USAGE = `Usage: aeon record ui ${UI_ACTIONS.join("|")} [--browser <name>] [--out <dir>] [--mark <name>]`;

export function isUiAction(action: string | undefined): action is UiAction {
  return (UI_ACTIONS as readonly string[]).includes(action ?? "");
}

/** The extension page for a Manage view: home is Manage itself, the rest are `?view=` routes. */
export function pageUrl(extensionId: string, action: (typeof PAGE_ACTIONS)[number]): string {
  return extensionUrl(extensionId, action === "home" ? "home.html" : `home.html?view=${action}`);
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

const ACTIVE =
  "const tabs = await browser.tabs(); const tab = tabs.find((t) => t.active && /^https?:/.test(t.url)) ?? tabs.find((t) => /^https?:/.test(t.url)); if (!tab) throw new Error('No web page is open');";

export async function performUi(action: string | undefined, deps: UiDeps): Promise<UiStep> {
  const step = resolveUiAction(action, isPage(action) ? await deps.extensionId() : "");
  if (step.kind === "page")
    await deps.run(
      `await browser.keepPage(${JSON.stringify(step.url)}, { foreground: true }); return "opened";`,
    );
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
    throw new Error(`${command.cmd} is needed to press Aeon's shortcut: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${command.cmd} failed: ${(run.stderr ?? "").trim()}`);
}

export function liveUiDeps(host: DaemonHost): UiDeps {
  return {
    extensionId: () => aeonExtensionId(),
    run: (code) => host.runInBrowser(code, { session: "aeon-record", timeoutMs: 20_000 }),
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

/** `aeon record ui <action> [--mark <name>]`: the action, then (if recording) a mark at its beat. */
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
