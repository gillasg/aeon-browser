import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// A model once answered a site's "too many attempts, try again later" with `sleep 1680` and the
// chat timed out; another sat in a 480 s shell wait. Speed comes first, so the kernel refuses a
// shell call that waits on nothing for longer than browser_code lets a sleep run.

/** Longest idle wait a shell call may hold, in seconds (browser_code caps a sleep at 30 s too). */
export const MAX_IDLE_WAIT_SECONDS = 30;

export const IDLE_WAIT_REFUSAL = `BLOCKED: a shell wait over ${MAX_IDLE_WAIT_SECONDS} s is refused. Wait for a real condition instead (browser_code: page.waitFor, page.network.waitFor). A site that says "too many attempts" or "try again later" is not waited out: use another way the site offers, or stop and report the limit and when to retry.`;

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

function sleepArgs(args: string): number {
  return args
    .trim()
    .split(/\s+/)
    .reduce((sum, part) => {
      const [, n = "0", u = ""] = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(part) ?? [];
      return sum + Number(n) * (UNIT[u.toLowerCase()] ?? 1);
    }, 0);
}

function startSleepArgs(args: string): number {
  const ms = /-m(?:illiseconds)?\s+(\d+)/i.exec(args);
  if (ms) return Number(ms[1]) / 1000;
  const sec = /(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)/i.exec(args);
  return sec ? Number(sec[1]) : 0;
}

/** Each wait a shell can do, and how many seconds its match waits. */
const WAITS: [RegExp, (m: RegExpExecArray) => number][] = [
  [/^sleep\s+((?:\d+(?:\.\d+)?[smhd]?\s*)+)$/i, (m) => sleepArgs(m[1] ?? "")],
  [/^start-sleep\b(.*)$/i, (m) => startSleepArgs(m[1] ?? "")],
  [/^timeout(?:\.exe)?\s+\/t\s+(\d+)/i, (m) => Number(m[1])],
  [
    /^ping(?:\.exe)?\s+(?:.*\s)?-n\s+(\d+)\s+(?:.*\s)?(?:127\.0\.0\.1|localhost)\b/i,
    (m) => Math.max(0, Number(m[1]) - 1),
  ],
  [/\[(?:System\.)?Threading\.Thread\]::Sleep\(\s*(\d+)/i, (m) => Number(m[1]) / 1000],
];

/** Seconds one shell statement waits on nothing, or 0 when it does real work. */
function waitSeconds(statement: string): number {
  const s = statement.trim();
  for (const [pattern, seconds] of WAITS) {
    const m = pattern.exec(s);
    if (m) return seconds(m);
  }
  return 0;
}

/** Total seconds a shell command spends in plain waits, across `&&`, `||`, `;` and new lines. */
export function idleWaitSeconds(command: string): number {
  return command
    .split(/&&|\|\||;|\n/)
    .map((part) => waitSeconds(part.replace(/^\s*\(+|\)+\s*$/g, "")))
    .reduce((sum, seconds) => sum + seconds, 0);
}

/** Whether a tool call is a shell wait longer than the cap. */
export function waitsTooLong(toolName: string, input: unknown): boolean {
  if (!SHELL_TOOLS.has(toolName)) return false;
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && idleWaitSeconds(command) > MAX_IDLE_WAIT_SECONDS;
}

export function idleWaitGuard(): InlineExtension {
  return {
    name: "idle-wait-guard",
    factory: (pi) => {
      pi.on("tool_call", (event) =>
        waitsTooLong(event.toolName, event.input)
          ? { block: true, reason: IDLE_WAIT_REFUSAL }
          : undefined,
      );
    },
  };
}
