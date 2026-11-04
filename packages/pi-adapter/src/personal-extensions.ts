// Whether Aeon's agent loads the user's own Pi setup (extensions, packages, skills and prompt
// templates from ~/.pi/agent and the workspace). Off by default: they are written for the Pi CLI,
// load slowly (about 40 s cold) and add tools and text Aeon's agent does not need. The user turns
// it on in Aeon Settings. Aeon's own built-in extensions always load.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PERSONAL_EXTENSIONS_FILE = "pi-extensions.json";

export function personalExtensionsEnabled(dataDirectory: string): boolean {
  try {
    const value = JSON.parse(
      readFileSync(join(dataDirectory, PERSONAL_EXTENSIONS_FILE), "utf8"),
    ) as { enabled?: unknown };
    return value.enabled === true;
  } catch {
    return false;
  }
}

export async function writePersonalExtensions(
  dataDirectory: string,
  enabled: boolean,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, PERSONAL_EXTENSIONS_FILE),
    JSON.stringify({ enabled }, null, 2) + "\n",
  );
}
