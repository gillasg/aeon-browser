import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const windows = process.env.WINDIR ?? "C:\\Windows";
const compilerCandidates = [
  join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

test(
  "native host poisons a timed-out or failed stdout reader",
  { skip: process.platform !== "win32" },
  () => {
    const compiler = compilerCandidates.find(existsSync);
    assert.ok(compiler, "the .NET Framework csc.exe used by the native host build is available");
    const directory = mkdtempSync(join(tmpdir(), "pippin-output-reader-"));
    try {
      const executable = join(directory, "probe.exe");
      const compile = spawnSync(
        compiler,
        [
          "/nologo",
          "/target:exe",
          `/out:${executable}`,
          "/reference:System.Core.dll",
          join(hostRoot, "DaemonOutputReader.cs"),
          join(hostRoot, "test", "DaemonOutputReaderProbe.cs"),
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(compile.status, 0, compile.stderr || compile.stdout);
      const result = spawnSync(executable, [], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
