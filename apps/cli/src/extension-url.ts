// Aeon's extension pages by URL. The manifest `key` pins the extension id, so the CLI can name
// chrome-extension://<id>/home.html?view=… without asking Chrome.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Chrome's id for an extension with this manifest `key`: SHA-256 of the key, letters a–p. */
export function extensionIdFromKey(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  return [...digest.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");
}

/** The installed extension's id: AEON_EXTENSION_ID, else the one the manifest key pins. */
export async function aeonExtensionId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const pinned = env.AEON_EXTENSION_ID?.trim();
  if (pinned) return pinned;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const manifest = JSON.parse(
    await readFile(join(root, "apps", "chrome-extension", "manifest.native.json"), "utf8"),
  ) as { key?: string };
  if (!manifest.key) throw new Error("Aeon's extension manifest has no key.");
  return extensionIdFromKey(manifest.key);
}

/** `chrome-extension://<id>/<path>`. */
export function extensionUrl(id: string, path: string): string {
  return `chrome-extension://${id}/${path.replace(/^\/+/, "")}`;
}
