// A test profile keeps its downloads to itself: Chrome's download folder points inside the temp
// profile, never at the user's ~/Downloads.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Seeds <profile>/Default/Preferences with a download folder inside the profile; returns it. */
export async function seedDownloadDir(profile) {
  const downloads = join(profile, "Downloads");
  await mkdir(join(profile, "Default"), { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false },
      savefile: { default_directory: downloads },
    }),
  );
  return downloads;
}
