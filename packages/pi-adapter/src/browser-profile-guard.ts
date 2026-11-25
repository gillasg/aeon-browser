import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { sensitivePaths } from "./os-sandbox.js";

// Chrome's profile folder holds the user's saved passwords, cookies, history and every other
// profile's data. The agent reaches the browser through browser_code, never through those files:
// a model once copied and queried `Login Data` from a shell to check a save. The kernel refuses any
// shell or file call that names a browser profile folder, whatever the prompt says.

const PROFILE_PATH =
  /(chrome|chromium|edge|brave)[^"'\n]{0,40}user[ _]data|login[ _]data|google-chrome[\\/]|\.config[\\/](chromium|microsoft-edge|brave)|application support[\\/](google[\\/]chrome|chromium|microsoft edge|bravesoftware)/i;

/** Tools that act on the machine itself rather than through Aeon's browser tools. */
const MACHINE_TOOLS = new Set([
  "bash",
  "powershell",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
]);

export const PROFILE_REFUSAL =
  "BLOCKED: browser profile files (passwords, cookies, history) are never read, copied or changed from a tool. Use browser_code for the browser; to check a login was saved, read the [ok] line of the click that submitted it.";

/** Whether a tool call reaches into a browser's profile folder. */
export function touchesBrowserProfile(toolName: string, input: unknown): boolean {
  if (!MACHINE_TOOLS.has(toolName)) return false;
  // Shells escape the spaces in these paths (`Application\ Support`); match them either way.
  const text = JSON.stringify(input ?? {}).replace(/\\+(?= )/g, "");
  return PROFILE_PATH.test(text);
}

export const CREDENTIAL_REFUSAL =
  "BLOCKED: keychains, SSH/GPG keys, cloud credentials and Aeon's own tokens are never read, copied or changed from a tool.";

const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

// Credential stores named in a shell command, as `~/.ssh`, `$HOME/.aws` or an absolute path.
const SHELL_CREDENTIAL =
  /(^|[\s"'=:(])(~|\$\{?HOME\}?|\/(home|Users)\/[^/\s"']+|[a-z]:\\users\\[^\\\s"']+)[\\/](\.ssh|\.gnupg|\.aws|\.kube|\.netrc|\.git-credentials|\.password-store|\.config[\\/]gh|library[\\/]keychains|appdata[\\/](roaming|local)[\\/]microsoft[\\/]credentials)([\\/\s"']|$)/i;

/** The real file a path names: symlinks followed through the nearest part that exists. */
function canonical(path: string): string {
  let head = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      rest.unshift(head.slice(parent.length).replace(/^[\\/]+/, ""));
      head = parent;
    }
  }
}

function inside(path: string, root: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const p = fold(path);
  const r = fold(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

let protectedRoots: string[] | undefined;
function roots(): string[] {
  protectedRoots ??= [
    ...new Set(
      sensitivePaths(homedir()).flatMap((root) => [resolve(root), canonical(resolve(root))]),
    ),
  ];
  return protectedRoots;
}

/** The protected folder a file tool's path lands in after symlinks, if any. */
export function resolveProtectedTarget(
  toolName: string,
  input: unknown,
  cwd: string = process.cwd(),
  protect: readonly string[] = roots(),
): string | undefined {
  if (!FILE_TOOLS.has(toolName) || !input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "target"]) {
    const value = fields[key];
    if (typeof value !== "string" || !value) continue;
    const expanded = value.replace(/^~(?=$|[\\/])/, homedir());
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const real = canonical(resolve(absolute));
    const plain = resolve(absolute);
    const hit = protect.find((root) => {
      const full = resolve(root);
      return inside(real, full) || inside(real, canonical(full)) || inside(plain, full);
    });
    if (hit) return hit;
  }
  return undefined;
}

/** Whether a shell command names a credential store directly. */
export function shellTouchesCredentials(toolName: string, input: unknown): boolean {
  if (!SHELL_TOOLS.has(toolName)) return false;
  const text = JSON.stringify(input ?? {})
    .replace(/\\\\/g, "\\")
    .replace(/\\+(?= )/g, "");
  return SHELL_CREDENTIAL.test(text);
}

export function browserProfileGuard(cwd?: string): InlineExtension {
  return {
    name: "browser-profile-guard",
    factory: (pi) => {
      pi.on("tool_call", (event) => {
        if (touchesBrowserProfile(event.toolName, event.input))
          return { block: true, reason: PROFILE_REFUSAL };
        if (
          resolveProtectedTarget(event.toolName, event.input, cwd) ||
          shellTouchesCredentials(event.toolName, event.input)
        )
          return { block: true, reason: CREDENTIAL_REFUSAL };
        return undefined;
      });
    },
  };
}
