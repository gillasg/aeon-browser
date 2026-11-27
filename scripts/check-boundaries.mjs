import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRules = new Map([
  ["@graft/protocol", []],
  ["@graft/domain", []],
  ["@graft/location", []],
  ["@graft/store", ["@graft/domain"]],
  [
    "@graft/daemon",
    ["@graft/protocol", "@graft/domain", "@graft/location", "@graft/store", "@graft/pi-adapter"],
  ],
  ["@graft/pi-adapter", ["@graft/domain", "@graft/protocol"]],
  ["@graft/native-host", []],
  ["@graft/cli", ["@graft/location", "@graft/protocol", "@graft/pi-adapter"]],
  ["@graft/chrome-extension", ["@graft/protocol", "@graft/ui"]],
  ["@graft/ui", ["@graft/protocol"]],
]);
const packagePaths = new Map([
  ["@graft/protocol", "packages/protocol"],
  ["@graft/domain", "packages/domain"],
  ["@graft/location", "packages/location"],
  ["@graft/store", "packages/store"],
  ["@graft/daemon", "apps/daemon"],
  ["@graft/pi-adapter", "packages/pi-adapter"],
  ["@graft/native-host", "apps/native-host"],
  ["@graft/cli", "apps/cli"],
  ["@graft/chrome-extension", "apps/chrome-extension"],
  ["@graft/ui", "packages/ui"],
]);
const violations = [];

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return sourceFiles(child);
      return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [child] : [];
    }),
  );
  return nested.flat();
}

function moduleSpecifiers(source) {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  for (const statement of file.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier
    ) {
      if (ts.isStringLiteral(statement.moduleSpecifier))
        specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

// Light entry points a package may expose beside its root: small helpers a hot path needs without
// loading the whole package (graft repl / status start faster without the protocol's schemas).
const LIGHT_ENTRIES = ["@graft/protocol/version", "@graft/protocol/handoff-status"];

for (const [name, relativePath] of packagePaths) {
  const packageRoot = join(root, relativePath);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (relativePath.startsWith("packages/")) {
    const exports = Object.keys(manifest.exports ?? {}).filter(
      (entry) => !LIGHT_ENTRIES.includes(`${name}/${entry.slice(2)}`),
    );
    if (exports.length !== 1 || exports[0] !== ".") {
      violations.push(`${name} must expose only its package-root public API.`);
    }
  }
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  for (const file of await sourceFiles(packageRoot)) {
    const source = await readFile(file, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      const targetName = [...packagePaths.keys()].find(
        (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
      );
      if (targetName) {
        if (specifier !== targetName && !LIGHT_ENTRIES.includes(specifier)) {
          violations.push(`${relative(root, file)} deep-imports ${specifier}.`);
          continue;
        }
        if (!declared[targetName]) {
          violations.push(
            `${relative(root, file)} imports undeclared workspace dependency ${targetName}.`,
          );
        }
        if (!packageRules.get(name)?.includes(targetName)) {
          violations.push(`${name} is not allowed to depend on ${targetName}.`);
        }
        if (declared[targetName] !== "workspace:*") {
          violations.push(`${name} must use workspace:* for ${targetName}.`);
        }
      }

      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file), specifier);
        const packagePrefix = `${packageRoot}${sep}`;
        if (!resolved.startsWith(packagePrefix)) {
          violations.push(
            `${relative(root, file)} crosses its package boundary through ${specifier}.`,
          );
        }
      }
    }
  }
}

const visited = new Set();
const active = new Set();
function visit(name) {
  if (active.has(name)) {
    violations.push(`Workspace dependency cycle includes ${name}.`);
    return;
  }
  if (visited.has(name)) return;
  active.add(name);
  for (const dependency of packageRules.get(name) ?? []) {
    if (packagePaths.has(dependency)) visit(dependency);
  }
  active.delete(name);
  visited.add(name);
}

for (const name of packageRules.keys()) visit(name);
if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Workspace package roots, imports, and dependency graph are valid.\n");
}
