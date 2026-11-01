import { flag, has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { answer, send, waitForChange, type ChatState } from "./converse.js";
import type { DaemonHost } from "./host.js";

// `aeon send`, `aeon answer` and `aeon watch`: another agent (or a script) keeps talking to a chat
// it started, answers what the chat's agent asks, and follows it live.

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function sendCommand(host: DaemonHost): Command {
  return {
    name: "send",
    group: "Aeon",
    summary: "send another message into a chat",
    help: `Usage: aeon send <chatId> "<message>" [--steer] [--wait]

While the chat works, the message waits until its turn ends (--steer changes the current turn
instead). When it is idle, the message starts a new turn with the chat's model. --wait follows
the chat until it finishes or asks a question, as aeon watch does.`,
    run: async (args) => {
      const [chatId, ...words] = args.positional;
      const message = words.join(" ").trim();
      if (!chatId || !message) throw new Error('Usage: aeon send <chatId> "<message>"');
      const client = await host.connect();
      const sent = await send(client, chatId, message, { steer: has(args, "steer") });
      print({ chatId, ...sent });
      return has(args, "wait") ? follow(host, chatId, args) : 0;
    },
  };
}

function answerCommand(host: DaemonHost): Command {
  return {
    name: "answer",
    group: "Aeon",
    summary: "answer the question a chat's agent is waiting on",
    help: `Usage: aeon answer <chatId> "<answer>" [--question <questionId>]

confirm questions take yes or no; select questions take one of their choices or its number;
input questions take any text. aeon watch lists pending questions; --question picks one when
several are pending.`,
    run: async (args) => {
      const [chatId, ...words] = args.positional;
      if (!chatId || !words.length) throw new Error('Usage: aeon answer <chatId> "<answer>"');
      const result = await answer(
        await host.connect(),
        chatId,
        words.join(" "),
        flag(args, "question"),
      );
      print({ chatId, ...result });
      return 0;
    },
  };
}

function watchCommand(host: DaemonHost): Command {
  return {
    name: "watch",
    group: "Aeon",
    summary: "follow a chat live: steps, questions, answer (JSON lines)",
    help: `Usage: aeon watch <chatId> [--timeout <minutes>]

Prints one JSON line per new step ({step}), one per question ({question}, answer it with
aeon answer) and the answer when the chat finishes ({done, answer}), then exits. Exits 1 after
the timeout (default 20 minutes) while the chat still works.`,
    run: (args) => {
      const chatId = args.positional[0];
      if (!chatId) throw new Error("Usage: aeon watch <chatId>");
      return follow(host, chatId, args);
    },
  };
}

/** Streams the chat's changes until it finishes; questions are printed once each. */
async function follow(host: DaemonHost, chatId: string, args: Args): Promise<number> {
  const client = await host.connect();
  const deadline = Date.now() + Number(flag(args, "timeout") ?? 20) * 60_000;
  const asked = new Set<string>();
  let since: number | undefined;
  while (Date.now() < deadline) {
    const state: ChatState = await waitForChange(client, chatId, {
      ...(since !== undefined ? { since } : {}),
      timeoutMs: Math.min(30_000, deadline - Date.now()),
    });
    for (const step of state.newSteps) print({ step });
    since = state.steps;
    for (const question of state.questions.filter((item) => !asked.has(item.questionId))) {
      asked.add(question.questionId);
      print({ question });
    }
    if (!state.working) {
      print({ done: true, answer: state.answer ?? "" });
      return 0;
    }
    // Still waiting on an answer: check again shortly, not in a tight loop.
    if (state.questions.length && !state.newSteps.length)
      await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  print({ done: false, timeout: true });
  return 1;
}

export function converseCommands(host: DaemonHost): Command[] {
  return [sendCommand(host), answerCommand(host), watchCommand(host)];
}
