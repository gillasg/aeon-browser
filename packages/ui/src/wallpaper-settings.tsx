import { useEffect, useState, type ReactElement } from "react";
const key = "pippin-wallpaper";
export function applyWallpaper(): void {
  const saved = JSON.parse(localStorage.getItem(key) || "{}");
  document.documentElement.dataset.wallpaper = String(
    saved.enabled === true && document.body.dataset.host !== "panel",
  );
  document.documentElement.style.setProperty(
    "--wallpaper-image",
    saved.image ? 'url("' + saved.image + '")' : 'url("atmosphere-wallpaper.png")',
  );
}
export function WallpaperSettings(): ReactElement {
  const [saved, setSaved] = useState<{ enabled?: boolean; image?: string }>(() =>
    JSON.parse(localStorage.getItem(key) || "{}"),
  );
  const [error, setError] = useState("");
  const save = (next: typeof saved): void => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setSaved(next);
      applyWallpaper();
      window.dispatchEvent(new Event(key));
      setError("");
    } catch {
      setError("This image is too large to save. Choose a smaller image.");
    }
  };
  const upload = (file: File | undefined): void => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => save({ enabled: true, image: String(reader.result) });
    reader.readAsDataURL(file);
  };
  return (
    <div className="wallpaper-settings">
      <label className="settings-check">
        <input
          type="checkbox"
          checked={saved.enabled === true}
          onChange={(event) => save({ ...saved, enabled: event.target.checked })}
        />
        New-tab wallpaper
      </label>
      <p>
        Use the cloud wallpaper or choose your own image. Dots and a soft fade apply in light and
        dark mode.
      </p>
      <label>
        Wallpaper image{" "}
        <input type="file" accept="image/*" onChange={(event) => upload(event.target.files?.[0])} />
      </label>
      <button type="button" onClick={() => save({ enabled: saved.enabled === true })}>
        Use default wallpaper
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function useWallpaper(): void {
  useEffect(() => {
    applyWallpaper();
    window.addEventListener("storage", applyWallpaper);
    window.addEventListener("pippin-wallpaper", applyWallpaper);
    return () => {
      window.removeEventListener("storage", applyWallpaper);
      window.removeEventListener("pippin-wallpaper", applyWallpaper);
    };
  }, []);
}
