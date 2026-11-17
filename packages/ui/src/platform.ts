// One source for the platform-aware label of the shortcut that summons Aeon. Chrome UI text must
// never disagree about Cmd on macOS versus Ctrl elsewhere.

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

const platform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
  navigator.platform;

export const isMac = isMacPlatform(platform);
export const summonShortcut = isMac ? "Cmd+Shift+Space" : "Ctrl+Shift+Space";
