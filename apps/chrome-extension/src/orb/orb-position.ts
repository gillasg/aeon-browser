// Where the orb sits: one position for every site, measured from the bottom-left corner so it
// stays put when windows change size. Bottom-left by default; dragging the orb moves it everywhere.

export interface OrbPosition {
  left: number;
  bottom: number;
}

export const ORB_POSITION_KEY = "aeon-orb-position";
export const DEFAULT_ORB_POSITION: OrbPosition = { left: 56, bottom: 56 };

export function parseOrbPosition(value: unknown): OrbPosition {
  const candidate = value as Partial<OrbPosition> | null;
  if (
    typeof candidate?.left === "number" &&
    typeof candidate.bottom === "number" &&
    Number.isFinite(candidate.left) &&
    Number.isFinite(candidate.bottom)
  )
    return { left: Math.max(0, candidate.left), bottom: Math.max(0, candidate.bottom) };
  return DEFAULT_ORB_POSITION;
}

export async function loadOrbPosition(): Promise<OrbPosition> {
  const stored = await chrome.storage.local.get(ORB_POSITION_KEY).catch(() => ({}));
  return parseOrbPosition((stored as Record<string, unknown>)[ORB_POSITION_KEY]);
}

export async function saveOrbPosition(position: OrbPosition): Promise<void> {
  await chrome.storage.local.set({ [ORB_POSITION_KEY]: position }).catch(() => undefined);
}

/** Follows moves made in other tabs. Returns a function that stops listening. */
export function watchOrbPosition(onMove: (position: OrbPosition) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === "local" && ORB_POSITION_KEY in changes)
      onMove(parseOrbPosition(changes[ORB_POSITION_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
