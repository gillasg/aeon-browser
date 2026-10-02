import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRules = new Map([
  ["@pippin/protocol", []],
  ["@pippin/domain", []],
  ["@pippin/store", ["@pippin/domain"]],
  ["@pippin/daemon", ["@pippin/protocol", "@pippin/domain", "@pippin/store", "@pippin/pi-adapter"]],
  ["@pippin/chrome-extension", ["@pippin/protocol", "@pippin/ui"]],
  ["@pippin/ui", ["@pippin/protocol"]],
  ["@pippin/pi-adapter", ["@pippin/domain"]],
  ["@pippin/native-host", []],
]);
const packagePaths = new Map([
  ["@pippin/protocol", "packages/protocol"],
  ["@pippin/domain", "packages/domain"],
  ["@pippin/store", "packages/store"],
  ["@pippin/daemon", "apps/daemon"],
  ["@pippin/chrome-extension", "apps/chrome-extension"],
  ["@pippin/ui", "packages/ui"],
  ["@pippin/pi-adapter", "packages/pi-adapter"],
  ["@pippin/native-host", "apps/native-host"],
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

for (const [name, relativePath] of packagePaths) {
  const packageRoot = join(root, relativePath);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (relativePath.startsWith("packages/")) {
    const exports = Object.keys(manifest.exports ?? {});
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
        if (specifier !== targetName) {
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
