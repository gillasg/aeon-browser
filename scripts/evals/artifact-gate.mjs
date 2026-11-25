// Release gate for extension permissions, host permissions, built artifacts, and secret leaks.
// Runs deterministically in Node after `pnpm build` (no Chrome, no network).
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
const ALLOWLIST_PATH = join(here, "extension-allowlist.json");

const SECRET_PATTERNS = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj|live|test)-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", re: /\bgh[po]_[A-Za-z0-9]{20,}\b/ },
  { name: "google-api-key", re: /\bAIzaSy[A-Za-z0-9_-]{25,}\b/ },
];

export function diffPermissionSet(actual, allowed) {
  const actualSet = new Set(actual);
  const allowedSet = new Set(allowed);
  const unapproved = [...actualSet].filter((item) => !allowedSet.has(item)).sort();
  const stale = [...allowedSet].filter((item) => !actualSet.has(item)).sort();
  return { unapproved, stale };
}

export function validateManifest(manifest, policy, forbiddenHosts) {
  const errors = [];
  const perms = diffPermissionSet(manifest.permissions ?? [], policy.permissions ?? []);
  if (perms.unapproved.length > 0) {
    errors.push(`unapproved permissions: ${perms.unapproved.join(", ")}`);
  }
  if (perms.stale.length > 0) {
    errors.push(`stale allowlist permissions: ${perms.stale.join(", ")}`);
  }
  const hosts = manifest.host_permissions ?? [];
  for (const host of hosts) {
    if (forbiddenHosts.includes(host)) errors.push(`forbidden host_permission: ${host}`);
  }
  const hostDiff = diffPermissionSet(hosts, policy.host_permissions ?? []);
  if (hostDiff.unapproved.length > 0) {
    errors.push(`unapproved host_permissions: ${hostDiff.unapproved.join(", ")}`);
  }
  if (hostDiff.stale.length > 0) {
    errors.push(`stale allowlist host_permissions: ${hostDiff.stale.join(", ")}`);
  }
  return errors;
}

export function scanForSecrets(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) hits.push(pattern.name);
  }
  return hits;
}

async function checkManifestEntry(repoRoot, relPath, policy, forbiddenHosts) {
  const fullPath = join(repoRoot, relPath);
  const raw = await readFile(fullPath, "utf8");
  const manifest = JSON.parse(raw);
  const errors = validateManifest(manifest, policy, forbiddenHosts);
  for (const leak of scanForSecrets(raw)) errors.push(`secret leak detected: ${leak}`);
  return { path: relPath, ok: errors.length === 0, errors };
}

async function checkArtifactEntry(repoRoot, relPath) {
  const fullPath = join(repoRoot, relPath);
  const errors = [];
  try {
    const info = await stat(fullPath);
    if (!info.isFile() || info.size === 0) errors.push("artifact missing or empty");
    const raw = await readFile(fullPath, "utf8");
    if (relPath.endsWith(".json")) JSON.parse(raw);
    for (const leak of scanForSecrets(raw)) errors.push(`secret leak detected: ${leak}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { path: relPath, ok: errors.length === 0, errors };
}

export async function runArtifactGate(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const allowlist = JSON.parse(await readFile(options.allowlistPath ?? ALLOWLIST_PATH, "utf8"));
  const forbiddenHosts = allowlist.forbiddenHostPermissions ?? [];
  const manifestResults = [];
  for (const [relPath, policy] of Object.entries(allowlist.manifests ?? {})) {
    manifestResults.push(await checkManifestEntry(repoRoot, relPath, policy, forbiddenHosts));
  }
  const artifactResults = [];
  if (!options.skipArtifacts) {
    for (const relPath of allowlist.requiredArtifacts ?? []) {
      artifactResults.push(await checkArtifactEntry(repoRoot, relPath));
    }
  }
  const ok =
    manifestResults.every((entry) => entry.ok) && artifactResults.every((entry) => entry.ok);
  return { ok, manifests: manifestResults, artifacts: artifactResults };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const skipArtifacts = process.argv.includes("--manifests-only");
  const report = await runArtifactGate({ skipArtifacts });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
