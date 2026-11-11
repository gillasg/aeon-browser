import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Styles that must take colour from tokens.css or the cursor token group. */
export const RAW_COLOR_FILES = [
  "apps/chrome-extension/chat.css",
  "apps/chrome-extension/home.css",
  "apps/chrome-extension/orb.css",
  "apps/chrome-extension/atmosphere.css",
  "apps/chrome-extension/pages.css",
  "apps/chrome-extension/sidebar-layout.css",
  "apps/chrome-extension/site-scripts.css",
  "apps/chrome-extension/sidepanel.css",
  "apps/chrome-extension/src/orb/orb-overlay-style.ts",
  "browser/packages/engine/src/native-browser-cursor.ts",
  "browser/packages/engine/src/cursor-page.ts",
];

const colorPattern =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|rgba?\(\s*\d|hsla?\(\s*\d/gi;

/** Raw colour spellings outside comments. A digit is required so `rgb()` in prose does not count. */
export function rawColorHits(text) {
  const visible = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  return [...visible.matchAll(colorPattern)].map((match) => match[0]);
}

export function allowlistEntries(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

export async function scanRawColors(repo = root) {
  const allow = new Set(
    allowlistEntries(await readFile(join(repo, "scripts/raw-color-allowlist.txt"), "utf8")),
  );
  const failures = [];
  for (const file of RAW_COLOR_FILES) {
    if (allow.has(file)) continue;
    for (const hit of rawColorHits(await readFile(join(repo, file), "utf8")))
      failures.push(`${file}: ${hit}`);
  }
  return failures;
}

async function main() {
  const failures = await scanRawColors();
  if (failures.length === 0) {
    process.stdout.write("No raw colours outside the token files.\n");
    return;
  }
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) await main();
