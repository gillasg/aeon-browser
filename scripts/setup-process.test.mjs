import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pnpmCommand, runCommand } from "./setup-process.mjs";

test("a setup step runs a path with spaces and metacharacters without a shell", () => {
  const root = mkdtempSync(join(tmpdir(), "aeon setup-"));
  try {
    const folder = join(root, "Application Support", "aeon; touch injected");
    mkdirSync(folder, { recursive: true });
    const script = join(folder, "step.mjs");
    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
    );
    const output = runCommand(process.execPath, [script, "arg with spaces"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { argv: ["arg with spaces"], cwd: root });
    assert.equal(existsSync(join(root, "injected")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pnpm is the .cmd shim on Windows and a plain command elsewhere", () => {
  assert.equal(pnpmCommand("win32"), "pnpm.cmd");
  assert.equal(pnpmCommand("darwin"), "pnpm");
  assert.equal(pnpmCommand("linux"), "pnpm");
});
