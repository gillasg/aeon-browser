import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyToStableFolder } from "../scripts/extension-folder.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FIXED_ID = "npcdopokfkpfmepknhoecppgdgmkmihh";
const FIXED_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA89DgbMVu50oH2AAiN0vILGKRKc2ePGR9r1W92yDIiVq9n1rxtqxQZSLsxPKuymvi3wB9hpo0h9vJ3++teaw8fqBllliSeELEAUmPNhauLcvlKe1nhkbgRf2wXilCUVI+zumNinkqw5h85rew1FI894ev8M9wWzSHm90eL9WILlWTrjhdaNTpMs2w9sF8GrsKj+sX1anF9/iUfZ9hbracUa47Z2b4KiviZp5SlF6o+0SwFHbeOVM0Aq2nHMFujmfaOcW7TkxDdPXBns2uRY1CTmRIyi3B1pONLQd8ERteRbOlj2BM9AYIrnGyJScaKAu7OUht0gI4C/NlEhdQruxTfQIDAQAB";

function idFromKey(publicKeyBase64) {
  const hash = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest();
  let id = "";
  for (const byte of hash.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

test("the shipped manifest key derives the one fixed extension id", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "apps", "chrome-extension", "manifest.native.json"), "utf8"),
  );
  assert.equal(manifest.key, FIXED_KEY);
  assert.equal(idFromKey(manifest.key), FIXED_ID);
});

test("the native host pins that id and refuses a manifest with any other key", () => {
  const source = readFileSync(join(root, "apps", "native-host", "scripts", "install.mjs"), "utf8");
  assert.match(source, new RegExp(`EXTENSION_ID = "${FIXED_ID}"`));
  assert.match(source, /if \(manifest\.key !== EXTENSION_KEY\)/);
  assert.match(source, /allowed_origins: \[`chrome-extension:\/\/\$\{EXTENSION_ID\}\/`\]/);
});

test("setup never generates or pins a per-install extension key", () => {
  for (const file of ["scripts/setup.mjs", "apps/native-host/scripts/extension-folder.mjs"]) {
    const source = readFileSync(join(root, file), "utf8");
    for (const forbidden of [
      "generateKeyPairSync",
      "pinManifestKey",
      "installManagedExtension",
      "extension-install.mjs",
      "manifest.key =",
    ])
      assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
  }
});

test("the built folder keeps the manifest byte-for-byte, so its id cannot drift", async () => {
  const base = await mkdtemp(join(tmpdir(), "graft-stable-folder-"));
  const source = join(base, "native-dist");
  const target = join(base, "stable");
  try {
    mkdirSync(source, { recursive: true });
    const manifest = JSON.stringify({ name: "Graft", key: FIXED_KEY }, null, 2);
    writeFileSync(join(source, "manifest.json"), manifest);
    mkdirSync(join(source, "nested"));
    writeFileSync(join(source, "nested", "worker.js"), "console.log(1)");
    copyToStableFolder(source, target);
    assert.equal(await readFile(join(target, "manifest.json"), "utf8"), manifest);
    assert.equal(await readFile(join(target, "nested", "worker.js"), "utf8"), "console.log(1)");
    assert.equal(
      idFromKey(JSON.parse(await readFile(join(target, "manifest.json"), "utf8")).key),
      FIXED_ID,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
