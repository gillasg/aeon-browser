import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["apps", "packages", "scripts"].map((path) => join(root, path));
const maxLines = 320;
const maxBytes = 16 * 1024;
const generatedDirectories = new Set(["dist", "dev-dist", "node_modules"]);
const notices = [];
const failures = [];

async function visit(path, files = []) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !generatedDirectories.has(entry.name)) await visit(child, files);
    else if (/\.(?:ts|tsx|mjs|cs)$/.test(entry.name)) files.push(child);
  }
  return files;
}

for (const path of sourceRoots) {
  for (const file of await visit(path)) {
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r?\n/).length;
    const bytes = (await stat(file)).size;
    const label = relative(root, file);
    if (lines > maxLines || bytes > maxBytes)
      failures.push(`${label}: ${lines} lines, ${bytes} bytes`);
    else if (lines > 240) notices.push(`Review ${label}: ${lines} lines.`);
    else if (lines > 180) notices.push(`Above 180-line aim: ${label} has ${lines} lines.`);
  }
}

if (notices.length > 0) process.stdout.write(`${notices.join("\n")}\n`);
if (failures.length > 0) {
  process.stderr.write(`Source limits exceeded (320 lines or 16 KiB):\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("All authored source files are below 320 lines and 16 KiB.\n");
}
