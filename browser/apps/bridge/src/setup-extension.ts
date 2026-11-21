import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "./paths.js";

// The extension half of setup, built to finish in under a minute without the Web Store. From a
// source checkout the built folder is used; from an npm install the extension of the latest
// release is downloaded and unpacked into the data folder. Then the extensions page opens in the
// Chromium browser that is installed, with the folder's path on the clipboard, and three numbered
// steps say what to click while setup waits for the extension to connect.

const RELEASES = "https://api.github.com/repos/gillasg/aeon-browser/releases/latest";

/** Built extension folders in a source checkout, best first: Aeon's own, then browserkit's. */
export function sourceBuilds(base: string = import.meta.url): string[] {
  return [
    // browser/apps/bridge/dist -> the monorepo's apps/chrome-extension.
    fileURLToPath(new URL("../../../../apps/chrome-extension/native-dist", base)),
    fileURLToPath(new URL("../../../../apps/chrome-extension/dist", base)),
    fileURLToPath(new URL("../../extension/build", base)),
  ];
}

/** The first folder that holds a manifest.json, or undefined. */
export function resolveExtensionFolder(
  candidates: string[],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return candidates.find((folder) => exists(join(folder, "manifest.json")));
}

type Asset = { name: string; browser_download_url: string };

// Release names over time: Aeon's extension zip first, then the older browserkit one.
const ASSET_PATTERNS = [
  /^aeon-extension-.*\.zip$/,
  /^aeon-browser-extension-.*\.zip$/,
  /^browserkit-.*\.zip$/,
];

/** The release asset that is the extension, preferring the newest naming. */
export function matchReleaseAsset<T extends { name: string }>(assets: T[] = []): T | undefined {
  for (const pattern of ASSET_PATTERNS) {
    const found = assets.find((asset) => pattern.test(asset.name));
    if (found) return found;
  }
  return undefined;
}

export async function extensionFolder(
  log: (line: string) => void,
  options: { fresh?: boolean } = {},
): Promise<string> {
  const built = resolveExtensionFolder(sourceBuilds());
  if (built) return built;
  const folder = join(dataDirectory(), "extension");
  if (!options.fresh && existsSync(join(folder, "manifest.json"))) return folder;
  log("Downloading the Aeon extension from the latest release…");
  const release = (await (
    await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } })
  ).json()) as { tag_name?: string; assets?: Asset[] };
  const asset = matchReleaseAsset(release.assets);
  if (!asset)
    throw new Error("No extension in the latest release; build it from source (see the README).");
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const zip = join(dataDirectory(), asset.name);
  await mkdir(dataDirectory(), { recursive: true });
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  unzip(zip, folder);
  await rm(zip, { force: true });
  log(`Extension ${release.tag_name ?? ""} unpacked at ${folder}`);
  return folder;
}

function unzip(zip: string, folder: string): void {
  // Windows 10+ and macOS ship a tar that reads zip files; Linux has unzip.
  const tries: [string, string[]][] =
    process.platform === "linux"
      ? [
          ["unzip", ["-q", "-o", zip, "-d", folder]],
          ["bsdtar", ["-xf", zip, "-C", folder]],
        ]
      : [["tar", ["-xf", zip, "-C", folder]]];
  for (const [command, args] of tries) {
    try {
      execFileSync(command, args, { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      // Try the next tool.
    }
  }
  throw new Error(`Could not unpack ${zip}; unzip it into ${folder} by hand.`);
}

/** A Chromium browser that is installed, and how to open a page in it. */
export type InstalledBrowser = {
  name: string;
  /** chrome://extensions, or the browser's own name for that page. */
  extensionsPage: string;
  open: (page: string) => [string, string[]];
};

type Known = {
  name: string;
  page?: string;
  mac?: string;
  linux?: string[];
  windows?: string[];
};

// In the order setup prefers them: the browser most people load the extension in comes first.
const KNOWN: Known[] = [
  {
    name: "Google Chrome",
    mac: "Google Chrome",
    linux: ["google-chrome", "google-chrome-stable"],
    windows: ["Google\\Chrome\\Application\\chrome.exe"],
  },
  {
    name: "Brave",
    page: "brave://extensions",
    mac: "Brave Browser",
    linux: ["brave-browser", "brave"],
    windows: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  },
  {
    name: "Microsoft Edge",
    page: "edge://extensions",
    mac: "Microsoft Edge",
    linux: ["microsoft-edge", "microsoft-edge-stable"],
    windows: ["Microsoft\\Edge\\Application\\msedge.exe"],
  },
  { name: "Arc", mac: "Arc" },
  {
    name: "Chromium",
    mac: "Chromium",
    linux: ["chromium", "chromium-browser"],
    windows: ["Chromium\\Application\\chrome.exe"],
  },
  {
    name: "Chrome Canary",
    mac: "Google Chrome Canary",
    linux: ["google-chrome-unstable"],
    windows: ["Google\\Chrome SxS\\Application\\chrome.exe"],
  },
];

export type DetectOptions = {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  home?: string;
};

/** The Chromium browsers installed on this machine, most preferred first. */
export function detectBrowsers(options: DetectOptions = {}): InstalledBrowser[] {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const found: InstalledBrowser[] = [];
  for (const known of KNOWN) {
    const extensionsPage = known.page ?? "chrome://extensions";
    if (platform === "darwin" && known.mac) {
      const app = `${known.mac}.app`;
      if ([posix.join("/Applications", app), posix.join(home, "Applications", app)].some(exists))
        found.push({
          name: known.name,
          extensionsPage,
          open: (page) => ["open", ["-a", known.mac!, page]],
        });
    } else if (platform === "linux" && known.linux) {
      const dirs = (env.PATH ?? "/usr/bin:/usr/local/bin").split(":").filter(Boolean);
      const binary = known.linux.find((name) => dirs.some((dir) => exists(posix.join(dir, name))));
      if (binary)
        found.push({ name: known.name, extensionsPage, open: (page) => [binary, [page]] });
    } else if (platform === "win32" && known.windows) {
      const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
        (root): root is string => Boolean(root),
      );
      const exe = known.windows
        .flatMap((relative) => roots.map((root) => `${root}\\${relative}`))
        .find(exists);
      if (exe) found.push({ name: known.name, extensionsPage, open: (page) => [exe, [page]] });
    }
  }
  return found;
}

/** Clipboard commands to try, in order, for this platform. */
export function clipboardCommands(
  platform: NodeJS.Platform = process.platform,
): [string, string[]][] {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

export type Runner = (command: string, args: string[], input: string) => void;

const runWithInput: Runner = (command, args, input) => {
  execFileSync(command, args, {
    input,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    timeout: 3000,
  });
};

/** Copies `text` with the first clipboard tool that works; says which one, or none. */
export function copyToClipboard(
  text: string,
  options: { platform?: NodeJS.Platform; run?: Runner } = {},
): { copied: boolean; tool?: string } {
  const run = options.run ?? runWithInput;
  for (const [command, args] of clipboardCommands(options.platform)) {
    try {
      run(command, args, text);
      return { copied: true, tool: command };
    } catch {
      // Not installed or no display: try the next one.
    }
  }
  return { copied: false };
}

/** The three numbered steps, worded for what setup managed to do. */
export function loadUnpackedSteps(
  folder: string,
  // copied is undefined when no copy was tried (a script, not a person at a terminal).
  info: {
    copied?: boolean | undefined;
    browser?: string;
    page?: string;
    platform?: NodeJS.Platform;
  },
): string[] {
  const paste = (info.platform ?? process.platform) === "darwin" ? "Cmd+V" : "Ctrl+V";
  const page = info.page ?? "chrome://extensions";
  const opened = info.browser ? `${page} is open in ${info.browser}` : `Open ${page} in Chrome`;
  return [
    `Load the extension (${opened}):`,
    "  1. Turn on Developer mode (top right).",
    "  2. Click Load unpacked.",
    info.copied
      ? `  3. Paste (${paste}) the folder path into the picker and select it — the path is already on your clipboard.`
      : info.copied === false
        ? "  3. Choose this folder in the picker (no clipboard tool worked, so copy it from here):"
        : "  3. Choose this folder in the picker:",
    `     ${folder}`,
  ];
}

/** Puts the folder on the clipboard and opens the extensions page; both best effort. */
export function presentExtension(folder: string): {
  copied: boolean;
  tool?: string;
  browser?: InstalledBrowser;
} {
  const clip = copyToClipboard(folder);
  const browser = detectBrowsers()[0];
  openPage(browser, browser?.extensionsPage ?? "chrome://extensions");
  return { ...clip, ...(browser ? { browser } : {}) };
}

export const AEON_EXTENSION_ID = "npcdopokfkpfmepknhoecppgdgmkmihh";

/**
 * After the extension connects, show the new user Aeon's Manage page (home.html; the extension no
 * longer overrides the New Tab page) rather than leaving them on chrome://extensions.
 */
export function openFirstRunPage(
  browser: InstalledBrowser | undefined = detectBrowsers()[0],
): void {
  openPage(browser, `chrome-extension://${AEON_EXTENSION_ID}/home.html`);
}

function openPage(browser: InstalledBrowser | undefined, page: string): void {
  const open: [string, string[]] = browser
    ? browser.open(page)
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", "chrome", page]]
      : process.platform === "darwin"
        ? ["open", ["-a", "Google Chrome", page]]
        : ["google-chrome", [page]];
  try {
    const child = spawn(open[0], open[1], { stdio: "ignore", detached: true, windowsHide: true });
    // A missing browser is normal (Chrome for Testing, no desktop name): never let the unhandled
    // 'error' event take down setup. The printed steps say where to go instead.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Not found under that name: the steps say where to go.
  }
}
