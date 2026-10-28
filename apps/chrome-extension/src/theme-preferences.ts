import {
  migrateLegacyChromeStorage,
  migrateLegacyLocalStorage,
} from "@browserkit/engine/legacy-storage-migration";

migrateLegacyLocalStorage();

export async function applyStoredTheme(): Promise<void> {
  await migrateLegacyChromeStorage();
  const values = await chrome.storage.sync.get("aeon-theme");
  const value = values["aeon-theme"];
  if (value === "atmosphere") {
    localStorage.setItem("aeon-wallpaper", JSON.stringify({ enabled: true }));
    await chrome.storage.sync.set({ "aeon-theme": "light" });
  }
  // The orb's chat sits on other people's pages, so it is always dark like the orb.
  if (new URLSearchParams(location.search).get("host") === "orb") {
    document.documentElement.dataset.theme = "dark";
    return;
  }
  document.documentElement.dataset.theme =
    value === "light" || value === "system" || value === "midnight"
      ? value
      : value === "atmosphere"
        ? "light"
        : "dark";
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes["aeon-theme"]) void applyStoredTheme();
});
