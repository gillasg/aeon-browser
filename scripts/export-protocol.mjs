import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const destination = process.argv[2];
if (!destination)
  throw new Error("Usage: node scripts/export-protocol.mjs <browser-vendor-directory>");
const directory = resolve(destination);
await mkdir(directory, { recursive: true });
const manifest = JSON.parse(await readFile("packages/protocol/package.json", "utf8"));
const file = `pippin-protocol-${manifest.version}.tgz`;
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run through pnpm export:protocol.");
const packed = spawnSync(
  process.execPath,
  [pnpm, "--filter", "@pippin/protocol", "pack", "--out", join(directory, file)],
  { stdio: "ignore", windowsHide: true },
);
if (packed.status !== 0) throw new Error("Build and pack the protocol before exporting it.");
const sha256 = createHash("sha256")
  .update(await readFile(join(directory, file)))
  .digest("hex");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
const changes = spawnSync("git", ["status", "--porcelain", "--", "packages/protocol"], {
  encoding: "utf8",
  windowsHide: true,
});
const sourceHash = createHash("sha256");
for (const path of [
  "package.json",
  ...(await readdir("packages/protocol/src"))
    .filter((path) => path.endsWith(".ts"))
    .sort()
    .map((path) => "src/" + path),
])
  sourceHash.update(path).update(await readFile(join("packages/protocol", path)));
await writeFile(
  join(directory, "protocol-origin.json"),
  JSON.stringify(
    {
      package: manifest.name,
      version: manifest.version,
      source: "https://github.com/gillasg/core",
      revision: revision.status === 0 ? revision.stdout.trim() : null,
      sourceDirty: changes.status !== 0 || !!changes.stdout.trim(),
      sourceSnapshotSha256: sourceHash.digest("hex"),
      file,
      sha256,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`Exported ${file} with its source revision and checksum.\n`);
