import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

function fakeArea(initial) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get() {
      return Object.fromEntries(values);
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) values.delete(key);
    },
  };
}

async function runMigration(outfile, areas, store) {
  globalThis.chrome = { storage: areas };
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const originalKeys = Object.keys;
  Object.keys = (target) =>
    target === globalThis.localStorage ? [...store.keys()] : originalKeys(target);
  try {
    const { migrateLegacyChromeStorage, migrateLegacyLocalStorage } = await import(
      pathToFileURL(outfile).href
    );
    await migrateLegacyChromeStorage();
    migrateLegacyLocalStorage();
  } finally {
    Object.keys = originalKeys;
    delete globalThis.chrome;
    delete globalThis.localStorage;
  }
}

test("legacy extension storage moves to the Aeon keys without overwriting newer values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-storage-migration-"));
  try {
    const outfile = join(directory, "migration.mjs");
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../node_modules/@browserkit/engine/src/legacy-storage-migration.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const sync = fakeArea({ "pippin-theme": "light", "pippin-chat-sidebar-open": true });
    const local = fakeArea({
      "pippin-client-instance-id": "id-1",
      pippinModelCatalog: { models: [] },
      "aeon-client-instance-id": "id-2",
    });
    const session = fakeArea({ "pippin.initial-submit.7": { text: "hi" }, other: 1 });
    const store = new Map([
      ["pippin-wallpaper", "{}"],
      ["pippinMessageSendMode", "steer"],
      ["aeon-sidebar-expanded", "true"],
    ]);
    await runMigration(outfile, { sync, local, session }, store);
    assert.deepEqual(Object.fromEntries(sync.values), {
      "aeon-theme": "light",
      "aeon-chat-sidebar-open": true,
    });
    assert.deepEqual(Object.fromEntries(local.values), {
      "aeon-client-instance-id": "id-2",
      aeonModelCatalog: { models: [] },
    });
    assert.deepEqual(Object.fromEntries(session.values), {
      "aeon.initial-submit.7": { text: "hi" },
      other: 1,
    });
    assert.deepEqual(Object.fromEntries(store), {
      "aeon-sidebar-expanded": "true",
      "aeon-wallpaper": "{}",
      aeonMessageSendMode: "steer",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
