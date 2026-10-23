import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "native configuration retries partial writes without accepting broken installations",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "aeon-host-config-"));
    const root = fileURLToPath(new URL("../", import.meta.url));
    try {
      const executable = join(directory, "probe.exe");
      const compiled = spawnSync(
        join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
        [
          "/nologo",
          "/target:exe",
          `/out:${executable}`,
          "/reference:System.Web.Extensions.dll",
          "/reference:System.Security.dll",
          join(root, "HostConfiguration.cs"),
          join(root, "test/HostConfigurationProbe.cs"),
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
      const result = spawnSync(executable, [directory], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stdout || result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
