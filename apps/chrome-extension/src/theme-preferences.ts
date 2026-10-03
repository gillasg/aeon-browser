export async function applyStoredTheme(): Promise<void> {
  const values = await chrome.storage.sync.get("pippin-theme");
  const value = values["pippin-theme"];
  if (value === "atmosphere") {
    localStorage.setItem("pippin-wallpaper", JSON.stringify({ enabled: true }));
    await chrome.storage.sync.set({ "pippin-theme": "light" });
  }
  document.documentElement.dataset.theme =
    value === "light" || value === "system" || value === "midnight" ? value : value === "atmosphere" ? "light" : "dark";
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes["pippin-theme"]) void applyStoredTheme();
});
