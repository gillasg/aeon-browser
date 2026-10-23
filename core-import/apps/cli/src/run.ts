import type { AeonClient, AttentionChat } from "./client.js";
import { summarize, type ChatResult } from "./results.js";

// Runs tasks as real Aeon chats, a batch at a time. Each chat opens as a background tab in the
// connected Chrome (unless quiet) so the user can watch, and finishes when Core reports it idle.
export interface RunOptions {
  parallel: number;
  quiet: boolean;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  timeoutMs: number;
  onProgress?: (line: string) => void;
  onStarted?: (index: number, chatId: string) => void;
}

interface Selection {
  model: { provider: string; id: string };
  thinkingLevel: string;
}

export async function runTasks(
  client: AeonClient,
  prompts: string[],
  options: RunOptions,
): Promise<ChatResult[]> {
  const selection = await chooseModel(client, options);
  const results: ChatResult[] = new Array<ChatResult>(prompts.length);
  let next = 0;
  const worker = async () => {
    while (next < prompts.length) {
      const index = next++;
      results[index] = await runOne(client, prompts[index] ?? "", selection, options, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallel, prompts.length) }, worker));
  return results;
}

async function chooseModel(client: AeonClient, options: RunOptions): Promise<Selection> {
  const result = await client.command("chat.model-catalog", {});
  const catalog = result.catalog as {
    defaultModel: { provider: string; id: string } | null;
    models: {
      provider: string;
      id: string;
      defaultThinkingLevel: string;
      thinkingLevels: string[];
    }[];
  };
  const wanted = options.model ?? catalog.defaultModel;
  const model = catalog.models.find(
    (item) => item.provider === wanted?.provider && item.id === wanted.id,
  );
  if (!model) {
    const problem = wanted
      ? `${wanted.provider}/${wanted.id} isn't available.`
      : "Pi has no default model.";
    const hint = wanted
      ? `Sign in to ${wanted.provider} again from the model picker ("Add or manage models…").`
      : 'Pass --model provider/id or sign in from the model picker ("Add or manage models…").';
    throw new Error(`${problem} ${hint}`);
  }
  const thinkingLevel = options.thinkingLevel ?? model.defaultThinkingLevel;
  if (!model.thinkingLevels.includes(thinkingLevel))
    throw new Error(`Thinking level ${thinkingLevel} is not offered by ${model.id}.`);
  return { model: { provider: model.provider, id: model.id }, thinkingLevel };
}

async function runOne(
  client: AeonClient,
  prompt: string,
  selection: Selection,
  options: RunOptions,
  index: number,
): Promise<ChatResult> {
  const started = Date.now();
  const finished = waitForIdle(client, options.timeoutMs);
  const created = await client.command("chat.create", { title: prompt.slice(0, 80) });
  const chatId = String((created.chat as { chatId: string }).chatId);
  finished.track(chatId);
  options.onStarted?.(index, chatId);
  if (!options.quiet) await client.openChat(chatId);
  options.onProgress?.(`[${index + 1}] started ${chatId}`);
  // The daemon submits it directly, so quiet runs need no tab and an unloaded tab cannot hold it up.
  await client.submit(chatId, prompt, selection);
  const outcome = await finished.done;
  const view = await client.command("chat.get", { chatId });
  const result = summarize(chatId, prompt, view.snapshot, Date.now() - started, outcome);
  options.onProgress?.(`[${index + 1}] ${result.status} in ${Math.round(result.seconds)}s`);
  return result;
}

/** A chat's answer and trace as it stands now. */
export async function inspect(client: AeonClient, chatId: string): Promise<ChatResult> {
  const view = await client.command("chat.get", { chatId });
  return summarize(chatId, "", view.snapshot, 0, "finished");
}

// Core's attention feed reports each chat's working flag; a chat is done once it has been seen
// working and then stops, or it times out.
function waitForIdle(
  client: AeonClient,
  timeoutMs: number,
): { track(chatId: string): void; done: Promise<"finished" | "timeout"> } {
  let chatId: string | undefined;
  let seenWorking = false;
  let resolveDone: (value: "finished" | "timeout") => void = () => undefined;
  const done = new Promise<"finished" | "timeout">((resolve) => (resolveDone = resolve));
  const timer = setTimeout(() => finish("timeout"), timeoutMs);
  const stop = client.onAttention((chats: AttentionChat[]) => {
    const chat = chats.find((item) => item.chatId === chatId);
    if (!chat) return;
    if (chat.working) seenWorking = true;
    else if (seenWorking || chat.completionId) finish("finished");
  });
  function finish(value: "finished" | "timeout") {
    clearTimeout(timer);
    stop();
    resolveDone(value);
  }
  return { track: (id) => (chatId = id), done };
}
