// Safe OS bridges: opening an app deep link, probing for an OS keychain without reading from it, and
// an allowlist for peer browser extensions we cooperate with. Every process starts with execFile and
// no shell, so a URI is one argument and never parsed by a shell.
import { execFile } from "node:child_process";

export const SAFE_DEEP_LINK_SCHEMES: readonly string[] = [
  "mailto",
  "slack",
  "notion",
  "vscode",
  "vscode-insiders",
  "cursor",
  "obsidian",
  "linear",
  "figma",
  "zoommtg",
  "msteams",
  "spotify",
  "tel",
  "https",
];

export type DeepLinkCheck =
  { ok: true; uri: string; scheme: string } | { ok: false; reason: string };

// `&` is deliberately allowed: it separates query parameters (mailto:?subject=a&body=b). No shell ever
// parses the URI, and Windows goes through rundll32 rather than cmd.exe, so `&` has no special meaning here.
const SHELL_META = /[`$;|<>\\"'{}]/;

/** C0/C1 controls, line/paragraph separators and bidi overrides. */
function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

function textProblem(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri) return "empty or not a string";
  if (uri.length > 2048) return "longer than 2048 characters";
  if (hasControl(uri)) return "control characters";
  if (SHELL_META.test(uri)) return "shell metacharacters";
  return undefined;
}

/** Accepts only a URI with an allowlisted app scheme, no control characters and no shell metacharacters. */
export function validateDeepLink(
  uri: unknown,
  allowed: readonly string[] = SAFE_DEEP_LINK_SCHEMES,
): DeepLinkCheck {
  const problem = textProblem(uri);
  if (problem || typeof uri !== "string") return { ok: false, reason: problem ?? "not a string" };
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  if (!match) return { ok: false, reason: "no scheme" };
  const scheme = (match[1] ?? "").toLowerCase();
  if (!allowed.includes(scheme)) return { ok: false, reason: `scheme ${scheme}: is not allowed` };
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: "not a valid URI" };
  }
  if (scheme === "https" && !parsed.hostname)
    return { ok: false, reason: "https link without a host" };
  return { ok: true, uri, scheme };
}

export type Runner = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export const execRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { shell: false, timeout: 5000, windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

/** The opener command for this OS, the URI passed as one argument. */
export function openerFor(
  platform: NodeJS.Platform,
  uri: string,
): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: [uri] };
  if (platform === "win32")
    return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", uri] };
  return { file: "xdg-open", args: [uri] };
}

export async function openDeepLink(
  uri: string,
  options: { platform?: NodeJS.Platform; run?: Runner } = {},
): Promise<{ opened: boolean; scheme?: string; reason?: string }> {
  const check = validateDeepLink(uri);
  if (!check.ok) return { opened: false, reason: check.reason };
  const { file, args } = openerFor(options.platform ?? process.platform, check.uri);
  const result = await (options.run ?? execRunner)(file, args);
  return result.code === 0
    ? { opened: true, scheme: check.scheme }
    : { opened: false, scheme: check.scheme, reason: `${file} exited ${result.code}` };
}

export interface KeychainProbe {
  platform: NodeJS.Platform;
  available: boolean;
  backend?: "macos-keychain" | "secret-service" | "windows-credential-manager";
  tool?: string;
  detail?: string;
}

/** Whether an OS secret store is usable, from its CLI's presence alone: never lists or reads a secret. */
export async function probeKeychain(
  options: { platform?: NodeJS.Platform; run?: Runner; env?: NodeJS.ProcessEnv } = {},
): Promise<KeychainProbe> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execRunner;
  const env = options.env ?? process.env;
  if (platform === "darwin") {
    const r = await run("security", ["list-keychains", "-d", "user"]);
    return { platform, available: r.code === 0, backend: "macos-keychain", tool: "security" };
  }
  if (platform === "win32") {
    const r = await run("cmdkey", ["/?"]);
    return {
      platform,
      available: r.code === 0,
      backend: "windows-credential-manager",
      tool: "cmdkey",
    };
  }
  const tool = await run("secret-tool", ["--version"]);
  const bus = Boolean(env.DBUS_SESSION_BUS_ADDRESS);
  const probe: KeychainProbe = {
    platform,
    available: tool.code === 0 && bus,
    backend: "secret-service",
    tool: "secret-tool",
  };
  if (tool.code !== 0) probe.detail = "secret-tool not installed";
  else if (!bus) probe.detail = "no D-Bus session bus";
  return probe;
}

export interface PeerExtension {
  id: string;
  name: string;
  messages: string[];
}

/** Peer extensions we talk to, each with the message types it may send us. */
export class ExtensionCoopRegistry {
  private readonly peers = new Map<string, PeerExtension>();

  constructor(peers: PeerExtension[] = []) {
    for (const peer of peers) this.register(peer);
  }

  register(peer: PeerExtension): void {
    if (!/^[a-p]{32}$/.test(peer.id))
      throw new Error(`INVALID_INPUT: extension id ${peer.id} is not a Chrome id`);
    this.peers.set(peer.id, {
      id: peer.id,
      name: String(peer.name).slice(0, 80),
      messages: [...new Set(peer.messages)],
    });
  }

  remove(id: string): boolean {
    return this.peers.delete(id);
  }

  get(id: string): PeerExtension | undefined {
    const peer = this.peers.get(id);
    return peer ? { ...peer, messages: [...peer.messages] } : undefined;
  }

  list(): PeerExtension[] {
    return [...this.peers.keys()].map((id) => this.get(id) as PeerExtension);
  }

  /** True only for an allowlisted peer sending a message type it was registered for. */
  canMessage(id: string, type: string): boolean {
    return this.peers.get(id)?.messages.includes(type) ?? false;
  }
}
