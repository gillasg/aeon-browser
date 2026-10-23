import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const windows = process.env.WINDIR ?? "C:\\Windows";
const compilerCandidates = [
  join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const compiler = await findCompiler(compilerCandidates);
if (!compiler) throw new Error("The Windows .NET Framework C# compiler (csc.exe) was not found.");

const output = join(root, "dist");
await mkdir(output, { recursive: true });
const executable = join(output, "aeon-native-host.exe");
const source = [
  "Program.cs",
  "HostConfiguration.cs",
  "NativeMessagingHost.cs",
  "DaemonSupervisor.cs",
  "DaemonOutputReader.cs",
  "SupervisorStatus.cs",
  "SupervisorLog.cs",
  "SupervisorPipe.cs",
];
const args = [
  "/nologo",
  "/target:exe",
  `/out:${executable}`,
  "/reference:System.Core.dll",
  "/reference:System.Security.dll",
  "/reference:System.Web.Extensions.dll",
  ...source.map((file) => join(root, file)),
];
await new Promise((resolve, reject) => {
  const child = spawn(compiler, args, { cwd: root, stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`csc.exe exited with status ${code ?? "unknown"}.`)),
  );
});
process.stdout.write(`Built runnable Chrome Native Messaging host: ${executable}\n`);

async function findCompiler(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the 32-bit framework compiler when the 64-bit path is unavailable.
    }
  }
  return undefined;
}
