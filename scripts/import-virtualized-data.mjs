import { createRequire } from "node:module";
import { mkdir, readdir, copyFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
const require = createRequire(new URL("../packages/store/package.json", import.meta.url));
const Database = require("better-sqlite3");
const [source, destination] = process.argv.slice(2).map((path) => resolve(path));
if (!source || !destination || source === destination) throw Error("Invalid import directories");
const backup = join(destination, "repair-backups", new Date().toISOString().replaceAll(":", "-"));
await mkdir(backup, { recursive: true });
for (const name of ["pippin.sqlite", "aeon-site-scripts.sqlite"]) {
  const origin = join(source, name),
    target = join(destination, name);
  if (!(await exists(origin))) continue;
  const database = new Database(target);
  try {
    await database.backup(join(backup, name));
    database.prepare("ATTACH DATABASE ? AS recovered").run(origin);
    const tables = database
      .prepare("SELECT name FROM recovered.sqlite_master WHERE type='table'")
      .all();
    database.transaction(() => {
      for (const { name: table } of tables) {
        if (
          !/^[a-z_]+$/.test(table) ||
          table.startsWith("sqlite_") ||
          table === "schema_migrations"
        )
          continue;
        if (
          !database
            .prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?")
            .get(table)
        )
          continue;
        const columns = database
          .prepare(`PRAGMA main.table_info(${table})`)
          .all()
          .map((item) => item.name);
        const recovered = new Set(
          database
            .prepare(`PRAGMA recovered.table_info(${table})`)
            .all()
            .map((item) => item.name),
        );
        if (!columns.every((column) => recovered.has(column)))
          throw Error("Recovery schema mismatch: " + table);
        const names = columns.map((column) => '"' + column + '"').join(",");
        database.exec(
          `INSERT OR IGNORE INTO main.${table} (${names}) SELECT ${names} FROM recovered.${table}`,
        );
      }
    })();
  } finally {
    database.close();
  }
}
await copyMissing(join(source, "workspaces"), join(destination, "workspaces"));
process.stdout.write(
  "Recovered additional chat metadata and workspace files; existing data preserved and databases backed up.\n",
);
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function copyMissing(origin, target) {
  if (!(await exists(origin))) return;
  await mkdir(target, { recursive: true });
  for (const item of await readdir(origin, { withFileTypes: true })) {
    const from = join(origin, item.name),
      to = join(target, item.name);
    if (item.isDirectory()) await copyMissing(from, to);
    else if (item.isFile() && !(await exists(to))) await copyFile(from, to);
  }
}
