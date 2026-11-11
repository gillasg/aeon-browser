import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/daemon-launcher.ps1", import.meta.url));
if (process.platform !== "win32") {
  process.stdout.write("skipped: Windows-only (PowerShell launcher)\n");
}

test(
  "Test-CorePing uses one 2s budget when the handshake is late",
  {
    timeout: 20_000,
    skip: process.platform === "win32" ? false : "Windows-only (PowerShell launcher)",
  },
  async () => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
      }, 1_500);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const command = [
      `. '${script.replaceAll("'", "''")}'`,
      "$sw = [Diagnostics.Stopwatch]::StartNew()",
      `Test-CorePing ${port} | Out-Null`,
      "Write-Output $sw.ElapsedMilliseconds",
    ].join("; ");
    try {
      const { code, stdout, stderr } = await runPwsh(command);
      assert.equal(code, 0, stderr || stdout);
      const elapsed = Number(stdout.trim().split(/\s+/).at(-1));
      assert.ok(elapsed > 1_400, `elapsed ${elapsed} ms (stdout ${stdout})`);
      assert.ok(elapsed < 2_800, `elapsed ${elapsed} ms (stdout ${stdout})`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

function runPwsh(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-Command", command], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
