// The extension folder the guided install presents to Chrome. It lives in Graft's data dir, so every
// update writes into the same path: Chrome keeps the extension (and its fixed id) across updates and
// only needs the three "Load unpacked" steps once.
//
// Linux could force-install from a local file:// update_url with a managed policy, but that needs a
// signing key kept on this machine, which would give each install its own extension id. Other parts
// of Graft (notably Site Boosts' companion list) trust the fixed id npcdopokfkpfmepknhoecppgdgmkmihh,
// so Linux uses the same guided flow as macOS and Windows rather than changing the id.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "../node/paths.mjs";

export const nativeDist = fileURLToPath(
  new URL("../../chrome-extension/native-dist", import.meta.url),
);
export const stableFolder = (options = {}) => join(dataDirectory(options), "extension");

/** Copy a built extension into the stable folder, overwriting it in place on every install. */
export function copyToStableFolder(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyToStableFolder(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
  }
}
