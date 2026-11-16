// The service file is written by the installer's shell, but it starts in the user manager's
// environment. Any data location the install resolved must therefore travel with the unit or the
// agent and the service disagree about where Aeon's data lives.
import { join } from "node:path";

export function serviceEnvironment(env = process.env) {
  return [
    ["XDG_DATA_HOME", env.XDG_DATA_HOME],
    ["AEON_DATA_DIR", env.AEON_DATA_DIR],
  ].filter((entry) => typeof entry[1] === "string" && entry[1].length > 0);
}

export function systemdUnit({ node, hostEntry, env = process.env }) {
  const environment = serviceEnvironment(env).map(
    ([key, value]) => `Environment=${systemdQuote(key + "=" + value)}`,
  );
  return [
    "[Unit]",
    "Description=Aeon daemon supervisor",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdQuote(node)} ${systemdQuote(hostEntry)} --daemon-supervisor`,
    "Restart=always",
    "RestartSec=2",
    "KillMode=mixed",
    "TimeoutStopSec=30",
    ...environment,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function launchAgent({ node, hostEntry, root, env = process.env }) {
  const environment = serviceEnvironment(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aeon.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(node)}</string><string>${escapeXml(hostEntry)}</string><string>--daemon-supervisor</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(root, "daemon-launchd.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(root, "daemon-launchd.log"))}</string>
${environmentVariables(environment)}</dict>
</plist>
`;
}

function environmentVariables(environment) {
  if (environment.length === 0) return "";
  const rows = environment
    .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("\n");
  return `  <key>EnvironmentVariables</key>
  <dict>
${rows}
  </dict>
`;
}

function systemdQuote(value) {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
