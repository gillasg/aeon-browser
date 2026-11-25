// Where a new background tab goes (the tabPlacement setting). A tab the user already has open is
// always worked in place; only a new background or fan-out tab (openTab {background: true}, the
// pools) is placed: in the session's own unfocused window ("background-window", the default) or,
// inactive, in the current window's agent tab group ("current-window-group").
import { registerSetting } from "./native-browser-settings.js";

export type TabPlacement = "background-window" | "current-window-group";
export const TAB_PLACEMENT_KEY = "browserkit-tab-placement";
export const TAB_PLACEMENTS: readonly TabPlacement[] = [
  "background-window",
  "current-window-group",
];

export async function tabPlacement(): Promise<TabPlacement> {
  const saved = (await chrome.storage.local.get(TAB_PLACEMENT_KEY).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return saved[TAB_PLACEMENT_KEY] === "current-window-group"
    ? "current-window-group"
    : "background-window";
}

/** The space a new tab opens in: an explicit space wins, then placement for background tabs. */
export async function placementSpace(
  step: { space?: "window" | "tabs" | undefined; background?: boolean | undefined },
  fallback: () => "window" | "tabs",
): Promise<"window" | "tabs"> {
  if (step.space) return step.space;
  if (!step.background) return fallback();
  return (await tabPlacement()) === "background-window" ? "window" : "tabs";
}

registerSetting("tabPlacement", {
  about:
    "Where new background tabs an agent opens go: its own unfocused window, or inactive in this window's agent tab group",
  values: [...TAB_PLACEMENTS],
  read: tabPlacement,
  write: (value) => chrome.storage.local.set({ [TAB_PLACEMENT_KEY]: value }),
});
