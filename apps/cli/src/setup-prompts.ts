import { createInterface } from "node:readline/promises";
import type { FlagResult } from "./chrome-flags.js";

// Opt-in questions at the end of `aeon setup`. They only run on a terminal without --yes, so
// CI and scripted installs never wait on input.

export interface PromptDeps {
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
  applyFlags: () => FlagResult;
  /** Ids of coding agents with a config on this machine. */
  detectAgents: () => Promise<string[]>;
  connectAgents: () => Promise<void>;
  connectedModels: () => Promise<number | undefined>;
  login: () => Promise<number>;
}

/** Empty answers take the default; anything starting with y means yes. */
export function yes(answer: string, fallback: boolean): boolean {
  const text = answer.trim().toLowerCase();
  return text ? text.startsWith("y") : fallback;
}

export async function setupPrompts(deps: PromptDeps): Promise<string[]> {
  const asked: string[] = [];
  if (!deps.interactive) return asked;
  const question = async (text: string, fallback: boolean) => {
    asked.push(text);
    return yes(await deps.ask(`${text} ${fallback ? "[Y/n]" : "[y/N]"} `), fallback);
  };
  const agents = await deps.detectAgents().catch(() => []);
  if (
    agents.length &&
    (await question(`Connect Aeon MCP to your coding agents (${agents.join(", ")})?`, true))
  )
    await deps.connectAgents();
  const models = await deps.connectedModels().catch(() => undefined);
  if (models === 0) {
    if (await question("Sign in to an AI model now?", true)) await deps.login();
    else deps.say("Later: connect an AI model with `aeon login`.");
  }
  // Last and optional: Enter skips it, and `aeon setup --undo-flags` reverts it at any time.
  if (
    await question(
      "Optional, reversible: relaunch-ready Chrome flags that hide the 'debugging this browser' banner?",
      false,
    )
  ) {
    const result = deps.applyFlags();
    deps.say(
      `${result.done ? "Done" : "Skipped"}: ${result.detail}. Restart Chrome to use them; undo with \`aeon setup --undo-flags\`.`,
    );
  }
  return asked;
}

/** The first minute after setup: own data back from a signed-in tab, then an agent connected. */
export function firstSixtySeconds(): string[] {
  return [
    "",
    "First 60 seconds:",
    "  1. Open any tab you are signed in to, then run:",
    "       aeon map --attach active --until-idle 8",
    "     Your own data comes back in about a second. No model, no API key.",
    "  2. Connect your coding agent:",
    "       aeon mcp",
  ];
}

export function terminalAsk(): (question: string) => Promise<string> {
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
