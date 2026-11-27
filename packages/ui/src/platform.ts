// One source for the platform-aware label of the shortcut that summons Graft. Chrome UI text must
// never disagree about ⌥ on macOS versus Alt elsewhere. The default is a rebindable
// chrome.commands entry (manifest.native.json).

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

/** The summon shortcut's label for a platform string (navigator or Node style). */
export function shortcutLabel(platform: string): string {
  return isMacPlatform(platform) || platform === "darwin" ? "⌥⇧Space" : "Alt+Shift+Space";
}

const platform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
  navigator.platform;

export const platformName: string = platform;
export const isMac = isMacPlatform(platform);
export const summonShortcut = shortcutLabel(platform);
