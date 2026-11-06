import type { InlineExtension } from "@earendil-works/pi-coding-agent";

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

export function browserProfileGuard(): InlineExtension {
  return {
    name: "browser-profile-guard",
    factory: (pi) => {
      pi.on("tool_call", (event) =>
        touchesBrowserProfile(event.toolName, event.input)
          ? { block: true, reason: PROFILE_REFUSAL }
          : undefined,
      );
    },
  };
}
