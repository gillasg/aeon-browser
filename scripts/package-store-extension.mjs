// Packs apps/chrome-extension/native-dist into a reproducible store zip (Chrome Web Store, Edge
// Add-ons). Same input, same bytes: sorted entries, fixed timestamps, no source maps. The store
// copy of manifest.json drops "key", since stores assign their own id.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_HOSTS = ["<all_urls>", "file:///*", "*://*/*"];
const SKIP = [/\.map$/, /(^|\/)\.DS_Store$/, /(^|\/)build-info\.json$/];

/** Store manifest checks; returns a list of problems, empty when the manifest can ship. */
export function validateStoreManifest(manifest) {
  const errors = [];
  if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
  for (const field of ["name", "version", "description"])
    if (typeof manifest[field] !== "string" || !manifest[field]) errors.push(`missing ${field}`);
  if ((manifest.description ?? "").length > 132) errors.push("description is over 132 characters");
  return [...errors, ...resourceErrors(manifest)];
}

function resourceErrors(manifest) {
  const hosts = (manifest.host_permissions ?? []).filter((host) => FORBIDDEN_HOSTS.includes(host));
  const statics = (manifest.web_accessible_resources ?? []).filter(
    (entry) => entry.use_dynamic_url !== true,
  );
  return [
    ...hosts.map((host) => `forbidden host_permission: ${host}`),
    ...statics.map(
      (entry) => `web_accessible_resources without use_dynamic_url: ${entry.resources}`,
    ),
  ];
}

/** Problems in the welcome page: it must stay on the void and never print unpublished commands. */
export function validateWelcomePage(html) {
  const errors = [];
  if (!/#000000/i.test(html)) errors.push("welcome.html must use the #000000 void");
  if (/npx\s+aeon/i.test(html)) errors.push("welcome.html must not print an npx command");
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)) errors.push("welcome.html has emoji");
  return errors;
}

export function storeFiles(dir) {
  const out = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const path = relative(dir, full).split(sep).join("/");
        if (!SKIP.some((re) => re.test(path))) out.push(path);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** A deterministic zip: deflated entries, DOS time fixed at 1980-01-01 00:00. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const name = Buffer.from(path, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    head.copy(dir, 8, 6, 30);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + packed.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

export function packageStore(dist, outFile) {
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  const errors = validateStoreManifest(manifest);
  const files = storeFiles(dist);
  if (files.includes("welcome.html"))
    errors.push(...validateWelcomePage(readFileSync(join(dist, "welcome.html"), "utf8")));
  if (errors.length) return { ok: false, errors };
  const store = { ...manifest };
  delete store.key;
  const entries = files.map((path) => ({
    path,
    data:
      path === "manifest.json"
        ? Buffer.from(JSON.stringify(store, null, 2) + "\n")
        : readFileSync(join(dist, path)),
  }));
  const bytes = zip(entries);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, bytes);
  return { ok: true, errors, manifest: store, files: files.length, bytes: bytes.length, outFile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = join(root, "apps", "chrome-extension", "native-dist");
  const out = join(root, "apps", "chrome-extension", "store", "aeon-extension.zip");
  const result = packageStore(dist, out);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`store package: ${error}\n`);
    process.exit(1);
  }
  const m = result.manifest;
  process.stdout.write(
    `${m.name} ${m.version} (MV${m.manifest_version})\n` +
      `description: ${m.description.length}/132 chars\n` +
      `permissions: ${(m.permissions ?? []).length}, host_permissions: ${(m.host_permissions ?? []).join(" ")}\n` +
      `files: ${result.files}, zip: ${(result.bytes / 1024).toFixed(1)} KiB\n` +
      `wrote ${relative(root, result.outFile)}\n`,
  );
}
