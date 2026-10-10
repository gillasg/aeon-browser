import { editSessionQueue } from "./session-queue-edit.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { PiAvailableModel, PiModelOption, PiSessionHandle } from "@aeon/domain";
import { decodePiInput } from "./pi-input.js";
import { browserContextPrompt, PI_BROWSER_CONTEXT_CUSTOM_TYPE } from "./browser-context-message.js";

type Controls = Pick<
  PiSessionHandle,
  "queue" | "editQueue" | "abort" | "controls" | "setModel" | "setThinkingLevel"
>;

export function createSessionControls(session: AgentSession): Controls {
  return {
    queue: async (input, mode) => {
      const decoded = decodePiInput(input);
      if (decoded.browserContext || decoded.browserContexts?.length)
        throw new Error("Wait for Pi to finish before sending a message with page context.");
      const text = `${decoded.text}${decoded.attachmentText}`;
      if (mode === "steer") await session.steer(text, decoded.images);
      else await session.followUp(text, decoded.images);
    },
    editQueue: (input) => editSessionQueue(session, input),
    abort: () => session.abort(),
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
      if (!model) throw new Error("The requested model is not available in this Pi session.");
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

export async function submitToPi(
  session: AgentSession,
  candidate: Parameters<PiSessionHandle["submit"]>[0],
): Promise<void> {
  const input = typeof candidate === "string" ? { text: candidate } : candidate;
  const decoded = decodePiInput(input);
  const browserContexts = [
    ...(decoded.browserContext ? [decoded.browserContext] : []),
    ...(decoded.browserContexts ?? []),
  ];
  if (browserContexts.length) {
    await session.sendCustomMessage(
      {
        customType: PI_BROWSER_CONTEXT_CUSTOM_TYPE,
        content: browserContexts.map(browserContextPrompt).join("\n\n"),
        display: false,
        details: { browserContext: browserContexts[0], browserContexts },
      },
      { deliverAs: "nextTurn" },
    );
  }
  await session.prompt(
    `${decoded.text}${decoded.attachmentText}`,
    decoded.images.length ? { images: decoded.images } : undefined,
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
