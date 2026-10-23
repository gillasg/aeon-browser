import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const Database = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "better-sqlite3",
);
test("redirected data import is additive and idempotent and preserves existing workspace files", () => {
  const root = mkdtempSync(join(tmpdir(), "aeon-import-"));
  const source = join(root, "source"),
    target = join(root, "target");
  try {
    for (const directory of [source, target]) {
      mkdirSync(join(directory, "workspaces"), { recursive: true });
      const database = new Database(
        join(directory, directory === source ? "pippin.sqlite" : "aeon.sqlite"),
      );
      database.exec(
        "CREATE TABLE chats(id TEXT PRIMARY KEY, value TEXT); INSERT INTO chats VALUES ('shared','original');",
      );
      database
        .prepare("INSERT INTO chats VALUES (?,?)")
        .run(directory === source ? "recovered" : "existing", "data");
      database.close();
      writeFileSync(
        join(directory, "workspaces", "shared.txt"),
        directory === source ? "recovered" : "existing",
      );
    }
    writeFileSync(join(source, "workspaces", "new.txt"), "recovered");
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("import-virtualized-data.mjs", import.meta.url)), source, target],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const database = new Database(join(target, "aeon.sqlite"));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM chats").get().count, 3);
    database.close();
    assert.equal(readFileSync(join(target, "workspaces", "shared.txt"), "utf8"), "existing");
    assert.equal(readFileSync(join(target, "workspaces", "new.txt"), "utf8"), "recovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
