import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The build-info.json written next to the built extension. Every heartbeat acknowledgement
// carries it; an extension built from different revisions reloads itself. Reading on each ack
// also catches a newer build that lands while Chrome stays open.

const installed = fileURLToPath(
  new URL("../../chrome-extension/native-dist/build-info.json", import.meta.url),
);

export async function installedExtensionBuild(): Promise<string | undefined> {
  try {
    return (await readFile(process.env.AEON_EXTENSION_BUILD_INFO ?? installed, "utf8")).trim();
  } catch {
    return undefined;
  }
}
