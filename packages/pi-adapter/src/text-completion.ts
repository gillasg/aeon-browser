import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

// One plain completion with the model a new chat would use: the same runtime (auth.json and
// models.json, so custom providers work) and the same default as the model picker.

export interface CompletionOptions {
  sessionDirectory: string;
  agentDirectory: string | undefined;
  preferredInitialModel: { provider: string; id: string } | undefined;
}

/** What the caller asked for: "provider/model" and a thinking level, both optional. */
export interface CompletionChoice {
  model?: string;
  thinking?: string;
}

const THINKING = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export async function defaultModel(
  options: CompletionOptions,
  choice: CompletionChoice,
): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const runtime = await ModelRuntime.create(
    options.agentDirectory
      ? {
          authPath: join(options.agentDirectory, "auth.json"),
          modelsPath: join(options.agentDirectory, "models.json"),
        }
      : {},
  );
  const models = await runtime.getAvailable();
  const settings = SettingsManager.create(options.sessionDirectory, options.agentDirectory);
  const wanted = (provider?: string, id?: string) =>
    models.find((model) => model.provider === provider && model.id === id);
  const [provider, ...id] = (choice.model ?? "").split("/");
  if (choice.model && !wanted(provider, id.join("/")))
    throw new Error(
      `${choice.model} is not available in Aeon. Use provider/model as in the model picker.`,
    );
  const model =
    wanted(provider, id.join("/")) ??
    wanted(options.preferredInitialModel?.provider, options.preferredInitialModel?.id) ??
    wanted(settings.getDefaultProvider(), settings.getDefaultModel()) ??
    models[0];
  if (!model) throw new Error("No AI model is connected in Aeon.");
  return { runtime, model };
}

/** Earlier turns are folded into one request as a transcript, so every provider takes them. */
function transcript(messages: { role: string; content: string }[]): string {
  const last = messages.at(-1)?.content ?? "";
  const earlier = messages
    .slice(0, -1)
    .map((message) => `${message.role === "assistant" ? "You" : "User"}: ${message.content}`)
    .join("\n\n");
  return earlier ? `Conversation so far:\n\n${earlier}\n\nNow:\n\n${last}` : last;
}

function replyText(reply: AssistantMessage, name: string): string {
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    throw new Error(`${name}: ${reply.errorMessage ?? "the model failed"}`);
  const text = reply.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error(`${name} returned no text`);
  return text;
}

export async function completeWithDefaultModel(
  options: CompletionOptions,
  system: string,
  messages: { role: string; content: string }[],
  choice: CompletionChoice = {},
): Promise<string> {
  const { runtime, model } = await defaultModel(options, choice);
  const reasoning =
    model.reasoning && choice.thinking && THINKING.has(choice.thinking)
      ? (choice.thinking as SimpleStreamOptions["reasoning"])
      : undefined;
  const reply = await runtime.completeSimple(
    model,
    {
      systemPrompt: system,
      messages: [{ role: "user", content: transcript(messages), timestamp: Date.now() }],
    },
    // OpenCode Go routes by session and refuses requests without one.
    { ...(reasoning ? { reasoning } : {}), sessionId: randomUUID() },
  );
  return replyText(reply, `${model.provider}/${model.id}`);
}

/** The default model as site-to-api's model interface (for explore and other model features). */
export function siteToolModel(
  options: CompletionOptions,
): () => Promise<{ complete(context: unknown): Promise<never> }> {
  return async () => {
    const { runtime, model } = await defaultModel(options, {});
    const sessionId = randomUUID();
    return {
      complete: (context) =>
        runtime.completeSimple(model, context as never, { sessionId }) as never,
    };
  };
}
