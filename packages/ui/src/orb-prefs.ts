// Orb settings, kept in the extension's localStorage ("on"/"off") so the settings page and
// orb.html (same origin) read the same values. Use with useAgentFlag.
export const ORB_REDUCE_MOTION_KEY = "aeonOrbReduceMotion";
export const ORB_SOUNDS_KEY = "aeonOrbSounds";

export function orbFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "on";
  } catch {
    return false;
  }
}
