import { editSessionQueue } from "./session-queue-edit.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  PiAvailableModel,
  PiBrowserContextRecord,
  PiModelOption,
  PiSessionHandle,
} from "@aeon/domain";
import { decodePiInput } from "./pi-input.js";
import { browserContextPrompt, PI_BROWSER_CONTEXT_CUSTOM_TYPE } from "./browser-context-message.js";
import { liveFirstTurn } from "./first-turn-live.js";
import { modelUnavailable } from "./model-unavailable.js";
import { watchBudget } from "./run-budget.js";
import { watchGuards } from "./run-guards.js";
import { endUserWaits, waitingOnUser } from "./user-waits.js";

type Controls = Pick<
  PiSessionHandle,
  "queue" | "editQueue" | "abort" | "controls" | "setModel" | "setThinkingLevel"
>;

export function createSessionControls(session: AgentSession, chatId: string): Controls {
  return {
    queue: async (input, mode) => {
      const decoded = decodePiInput(input);
      if (decoded.browserContext || decoded.browserContexts?.length)
        throw new Error("Wait for Pi to finish before sending a message with page context.");
      const text = `${decoded.text}${decoded.attachmentText}`;
      // A message sent while the chat waits on the user answers that wait, whatever the send mode.
      if (mode === "steer" || waitingOnUser(chatId)) {
        await session.steer(text, decoded.images);
        // The model reads a steer only between tools: end any wait on the user so it reads it now.
        endUserWaits(chatId);
      } else await session.followUp(text, decoded.images);
    },
    editQueue: (input) => editSessionQueue(session, input),
    abort: async () => {
      await session.abort();
      sendQueuedAfterStop(session);
    },
    controls: () => {
      const model = session.model;
      const availableModels = session.modelRuntime
        .getAvailableSnapshot()
        .map((item) => toModelOption(item, session));
      if (
        model &&
        !availableModels.some((item) => item.provider === model.provider && item.id === model.id)
      )
        availableModels.unshift(toModelOption(model, session));
      return {
        effectiveModel: model ? toModel(model) : null,
        availableModels,
        thinkingLevel: session.thinkingLevel,
        availableThinkingLevels: session.getAvailableThinkingLevels(),
        steeringQueue: [...session.getSteeringMessages()],
        followUpQueue: [...session.getFollowUpMessages()],
        active: !session.isIdle || session.isStreaming,
      };
    },
    setModel: async (provider, id) => {
      const model =
        session.model?.provider === provider && session.model.id === id
          ? session.model
          : session.modelRuntime
              .getAvailableSnapshot()
              .find((item) => item.provider === provider && item.id === id);
      if (!model) throw modelUnavailable(provider, id);
      await session.setModel(model, { persist: false });
    },
    setThinkingLevel: (level) => {
      const available = session.getAvailableThinkingLevels();
      if (!available.includes(level as (typeof available)[number]))
        throw new Error("The requested thinking level is not supported by the current model.");
      session.setThinkingLevel(level as Parameters<typeof session.setThinkingLevel>[0], {
        persist: false,
      });
    },
  };
}

/**
 * A stop ends the run, not what the user queued behind it: Pi keeps the queue after an abort and
 * nothing would ever send it. The queued messages go out now, in order, as the next message.
 */
export function sendQueuedAfterStop(
  session: Pick<AgentSession, "clearQueue" | "prompt">,
  log: (message: string) => void = (message) => process.stderr.write(message + "\n"),
): string | undefined {
  const { steering, followUp } = session.clearQueue();
  const queued = [...steering, ...followUp].filter((text) => text.trim());
  if (!queued.length) return undefined;
  const text = queued.join("\n\n");
  void session.prompt(text).catch((error: unknown) => {
    log("Aeon: could not send the queued message after a stop: " + String(error));
  });
  return text;
}

export async function submitToPi(
  session: AgentSession,
  candidate: Parameters<PiSessionHandle["submit"]>[0],
): Promise<void> {
  const input = typeof candidate === "string" ? { text: candidate } : candidate;
  const decoded = decodePiInput(input);
  const prompt = `${decoded.text}${decoded.attachmentText}`;
  const browserContexts = [
    ...(decoded.browserContext ? [decoded.browserContext] : []),
    ...(decoded.browserContexts ?? []),
  ];
  try {
    watchGuards(session);
  } catch {
    // A session without subscribe still sends the turn.
  }
  const context = await hiddenTurn(prompt, browserContexts, decoded.routeDraft);
  await sendHiddenTurn(session, context, browserContexts);
  if (input.budget) watchBudget(session, input.budget);
  await session.prompt(prompt, decoded.images.length ? { images: decoded.images } : undefined);
}

async function hiddenTurn(
  prompt: string,
  browserContexts: PiBrowserContextRecord[],
  routeDraft: ReturnType<typeof decodePiInput>["routeDraft"],
): Promise<string> {
  const turn = await liveFirstTurn(prompt, browserContexts, routeDraft);
  const context = turn.endsWith(`\n\n${prompt}`) ? turn.slice(0, -(prompt.length + 2)) : turn;
  const banner = browserContexts.map(browserContextPrompt).join("\n\n");
  return [context, banner].filter((part) => part.trim()).join("\n\n");
}

async function sendHiddenTurn(
  session: AgentSession,
  context: string,
  browserContexts: PiBrowserContextRecord[],
): Promise<void> {
  if (!context.trim()) return;
  await session.sendCustomMessage(
    {
      customType: PI_BROWSER_CONTEXT_CUSTOM_TYPE,
      content: context,
      display: false,
      details: browserContexts.length
        ? { browserContext: browserContexts[0], browserContexts }
        : { firstTurn: true },
    },
    { deliverAs: "nextTurn" },
  );
}

function toModel(model: { provider: string; id: string; name: string }): PiAvailableModel {
  return { provider: model.provider, id: model.id, name: model.name };
}

function toModelOption(model: Model<Api>, session: AgentSession): PiModelOption {
  const requestedThinkingLevel =
    session.settingsManager.getModelThinkingLevel(model.provider, model.id) ??
    session.settingsManager.getDefaultThinkingLevel() ??
    session.thinkingLevel;
  const defaultThinkingLevel = clampThinkingLevel(
    model,
    requestedThinkingLevel as Parameters<typeof clampThinkingLevel>[1],
  );
  return {
    ...toModel(model),
    thinkingLevels: getSupportedThinkingLevels(model),
    defaultThinkingLevel,
  };
}
