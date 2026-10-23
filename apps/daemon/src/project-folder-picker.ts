import { windowsFolderDialogSource } from "./windows-folder-dialog.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
let pending: Promise<string | null> | undefined;
export function pickProjectFolder(): Promise<string | null> {
  pending ??= chooseFolder().finally(() => {
    pending = undefined;
  });
  return pending;
}
async function chooseFolder(): Promise<string | null> {
  if (process.platform !== "win32")
    throw new Error("The native folder chooser is available on Windows.");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.Text = 'Aeon — choose project folder'",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$owner.Size = New-Object System.Drawing.Size(1,1)",
    "$owner.Opacity = 0",
    "Add-Type -TypeDefinition '" + windowsFolderDialogSource.replaceAll("'", "''") + "'",
    "try { $owner.Show(); $owner.Activate(); $owner.BringToFront(); $path = [PiperFolderDialog]::Choose($owner.Handle); if ($path) { [Console]::Write($path) } } finally { $owner.Close(); $owner.Dispose() }",
  ].join("; ");
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 120_000, maxBuffer: 16_384, encoding: "utf8" },
  );
  return stdout.trim() || null;
}
