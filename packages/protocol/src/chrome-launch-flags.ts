// The one list of Chrome launch flags Graft asks for. Setup, the launchers, `graft doctor` and the
// side panel's notice all read it, so they never drift. None is a stealth tell: no --test-type,
// no --no-sandbox, no fingerprint flags. All are optional; a normal Chrome launch runs every tool.

export const CHROME_FEATURE_FLAG = "CalculateNativeWinOcclusion";

export const CHROME_LAUNCH_FLAGS = [
  {
    flag: "--extensions-on-chrome-urls",
    purpose: "lets Graft work on chrome:// pages",
  },
  {
    flag: "--silent-debugger-extension-api",
    purpose: "hides Chrome's debugger bar while Graft drives a page",
  },
  {
    flag: "--disable-renderer-backgrounding",
    purpose: "keeps background tabs at full speed",
  },
  {
    flag: "--disable-background-timer-throttling",
    purpose: "keeps timers in background tabs on time",
  },
  {
    flag: "--disable-backgrounding-occluded-windows",
    purpose: "keeps covered windows running",
  },
  {
    flag: `--disable-features=${CHROME_FEATURE_FLAG}`,
    purpose: "stops Windows from pausing windows it thinks are hidden",
  },
] as const;

export const CHROME_FLAGS: readonly string[] = CHROME_LAUNCH_FLAGS.map((item) => item.flag);

const FEATURES = "--disable-features=";

function featureList(arg: string): string[] {
  return arg.slice(FEATURES.length).split(",").filter(Boolean);
}

/**
 * Adds every flag the args lack, keeping the user's own. `--disable-features=` lists merge into
 * one (`Foo` becomes `Foo,CalculateNativeWinOcclusion`), never a second copy.
 */
export function mergeChromeFlags(
  args: readonly string[],
  flags: readonly string[] = CHROME_FLAGS,
): string[] {
  const out: string[] = [];
  const features: string[] = [];
  let featureAt = -1;
  for (const arg of [...args, ...flags]) {
    if (!arg.startsWith(FEATURES)) {
      if (arg && !out.includes(arg)) out.push(arg);
      continue;
    }
    if (featureAt < 0) featureAt = out.push("") - 1;
    for (const feature of featureList(arg)) if (!features.includes(feature)) features.push(feature);
  }
  if (featureAt >= 0) out[featureAt] = FEATURES + features.join(",");
  return out;
}

function hasFlag(command: string, flag: string): boolean {
  const args = command.split(/\s+/);
  if (!flag.startsWith(FEATURES)) return args.includes(flag);
  const wanted = featureList(flag);
  const have = args.filter((arg) => arg.startsWith(FEATURES)).flatMap(featureList);
  return wanted.every((feature) => have.includes(feature));
}

/** The flags no Chrome command line carries; with no Chrome running, every flag is missing. */
export function missingChromeFlags(
  commandLines: readonly string[],
  flags: readonly string[] = CHROME_FLAGS,
): string[] {
  return flags.filter((flag) => !commandLines.some((command) => hasFlag(command, flag)));
}

export type ChromePlatform = "darwin" | "win32" | "linux";

export function chromePlatform(platform: string): ChromePlatform {
  if (/^darwin$|mac/i.test(platform)) return "darwin";
  if (/^win32$|win/i.test(platform)) return "win32";
  return "linux";
}

/** The copy-pasteable command that relaunches Chrome with the flags. Quit Chrome first. */
export function chromeRelaunchCommand(
  platform: string,
  flags: readonly string[] = CHROME_FLAGS,
): string {
  const os = chromePlatform(platform);
  if (os === "darwin") return `open -na "Google Chrome" --args ${flags.join(" ")}`;
  if (os === "win32")
    return `Start-Process chrome.exe -ArgumentList ${flags.map((flag) => `'${flag}'`).join(",")}`;
  return `google-chrome ${flags.join(" ")}`;
}

export function chromeFlagPurpose(flag: string): string {
  return CHROME_LAUNCH_FLAGS.find((item) => item.flag === flag)?.purpose ?? flag;
}
