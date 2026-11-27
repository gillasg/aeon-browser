// Packs the built extension (apps/chrome-extension/native-dist) into the zip uploaded to the
// Chrome Web Store. The store assigns its own extension ID, so the manifest "key" is removed.
// Usage: pnpm build, then node scripts/store/package-cws.mjs
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

export function storeManifest(manifest) {
  const rest = { ...manifest };
  delete rest.key;
  return rest;
}

function listFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

function header(size, fields) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 2) buffer.writeUInt16LE(value, offset);
    else buffer.writeUInt32LE(value >>> 0, offset);
    offset += bytes;
  }
  return buffer;
}

function zipEntry(name, data, offset) {
  const nameBytes = Buffer.from(name, "utf8");
  const packed = deflateRawSync(data);
  const crc = crc32(data);
  const shared = [
    [2, 20],
    [2, 0x0800],
    [2, 8],
    [2, 0],
    [2, 0x21],
    [4, crc],
  ];
  const sizes = [
    [4, packed.length],
    [4, data.length],
    [2, nameBytes.length],
    [2, 0],
  ];
  const local = header(30, [[4, 0x04034b50], ...shared, ...sizes]);
  const central = header(46, [
    [4, 0x02014b50],
    [2, 20],
    ...shared,
    ...sizes,
    [2, 0],
    [2, 0],
    [2, 0],
    [4, 0],
    [4, offset],
  ]);
  return {
    local: Buffer.concat([local, nameBytes, packed]),
    central: Buffer.concat([central, nameBytes]),
  };
}

export function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const entry = zipEntry(name, data, offset);
    locals.push(entry.local);
    centrals.push(entry.central);
    offset += entry.local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = header(22, [
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, entries.length],
    [2, entries.length],
    [4, directory.length],
    [4, offset],
    [2, 0],
  ]);
  return Buffer.concat([...locals, directory, end]);
}

export function packageCws(repoRoot = REPO_ROOT) {
  const dist = join(repoRoot, "apps/chrome-extension/native-dist");
  const manifest = storeManifest(JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")));
  const entries = listFiles(dist).map((path) => {
    const name = relative(dist, path).split("\\").join("/");
    const data =
      name === "manifest.json"
        ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
        : readFileSync(path);
    return { name, data };
  });
  const outDir = join(repoRoot, "apps/chrome-extension/store-dist");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `graft-${manifest.version}.zip`);
  writeFileSync(outPath, zipFiles(entries));
  return { outPath, files: entries.length, manifest };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { outPath, files } = packageCws();
  process.stdout.write(`packed ${files} files into ${outPath}\n`);
}
