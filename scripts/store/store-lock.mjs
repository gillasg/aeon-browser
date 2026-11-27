// Store permission lock: the extension manifest, the built manifest (when built) and the store
// zip manifest must ask for exactly what store/permissions.json allows, and store/listing.md must
// explain every one of those permissions to the reviewer.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storeManifest } from "./package-cws.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
export const LOCKED_FIELDS = [
  "permissions",
  "optional_permissions",
  "host_permissions",
  "content_scripts",
  "web_accessible_resources",
];
export const SUMMARY_LIMIT = 132;

const canonical = (value) => JSON.stringify(value ?? null);

export function diffLock(manifest, lock) {
  const errors = [];
  for (const field of LOCKED_FIELDS) {
    if (canonical(manifest[field]) !== canonical(lock[field]))
      errors.push(`${field} differs from store/permissions.json`);
  }
  for (const field of Object.keys(lock)) {
    if (!field.startsWith("$") && !LOCKED_FIELDS.includes(field))
      errors.push(`store/permissions.json has an unknown field: ${field}`);
  }
  return errors;
}

export function lockedNames(lock) {
  return [
    ...(lock.permissions ?? []),
    ...(lock.optional_permissions ?? []),
    ...(lock.host_permissions ?? []),
  ];
}

export function listingSummary(listing) {
  const lines = listing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Summary");
  if (start < 0) return undefined;
  return lines
    .slice(start + 1)
    .find((line) => line.trim() !== "")
    ?.trim();
}

export function listingErrors(listing, lock) {
  const errors = [];
  for (const name of lockedNames(lock)) {
    if (!listing.includes(`### \`${name}\``))
      errors.push(`store/listing.md has no justification for ${name}`);
  }
  const summary = listingSummary(listing);
  if (!summary) errors.push("store/listing.md has no summary");
  else if (summary.length > SUMMARY_LIMIT)
    errors.push(
      `store/listing.md summary is ${summary.length} characters (limit ${SUMMARY_LIMIT})`,
    );
  return errors;
}

export function packagingErrors(manifest) {
  const packed = storeManifest(manifest);
  const errors = "key" in packed ? ["store package keeps the manifest key"] : [];
  if (!("key" in manifest)) return errors;
  const rest = { ...manifest };
  delete rest.key;
  if (canonical(rest) !== canonical(packed))
    errors.push("store package changes more than the manifest key");
  return errors;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function runStoreLock(repoRoot = REPO_ROOT) {
  const lock = readJson(join(repoRoot, "store/permissions.json"));
  const sourcePath = join(repoRoot, "apps/chrome-extension/manifest.native.json");
  const builtPath = join(repoRoot, "apps/chrome-extension/native-dist/manifest.json");
  const source = readJson(sourcePath);
  const errors = diffLock(source, lock).map((error) => `manifest.native.json: ${error}`);
  if (existsSync(builtPath)) {
    const built = readJson(builtPath);
    errors.push(...diffLock(built, lock).map((error) => `built manifest: ${error}`));
    errors.push(...packagingErrors(built));
  }
  errors.push(...packagingErrors(source));
  errors.push(...listingErrors(readFileSync(join(repoRoot, "store/listing.md"), "utf8"), lock));
  return errors;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const errors = runStoreLock();
  for (const error of errors) process.stderr.write(`store lock: ${error}\n`);
  if (errors.length > 0) process.exitCode = 1;
  else process.stdout.write("store lock: ok\n");
}
