import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const FIXTURE_PROVIDER = "aeon-local-fixture";
const FIXTURE_MODEL = "read-only-stream";
const FIXTURE_RESPONSES = 64;
const DEFAULT_TOKENS_PER_SECOND = 35;

let requestCapture: ((context: TranscriptContext) => void) | undefined;

/** Record each context the local fixture model is asked to answer. The caller unsubscribes. */
export function captureFixtureModelRequest(
  capture: (context: TranscriptContext) => void,
): () => void {
  requestCapture = capture;
  return () => {
    if (requestCapture === capture) requestCapture = undefined;
  };
}

function scripted(message: AssistantMessage) {
  return (context: TranscriptContext): AssistantMessage => {
    requestCapture?.(context);
    return message;
  };
}

export function fixtureSessionOptions(
  fixture: Awaited<ReturnType<typeof createLocalFixtureModel>> | undefined,
  allowlist = true,
): Partial<Awaited<ReturnType<typeof createLocalFixtureModel>>> {
  if (!fixture) return {};
  const session = { modelRuntime: fixture.modelRuntime, model: fixture.model };
  return allowlist ? { ...session, tools: fixture.tools } : session;
}

export async function createLocalFixtureModel(agentDirectory: string): Promise<{
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  tools: string[];
}> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDirectory, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const fixture = fauxProvider({
    provider: FIXTURE_PROVIDER,
    api: "aeon-local-faux",
    models: [
      {
        id: FIXTURE_MODEL,
        name: "Aeon local fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 512,
      },
    ],
    tokensPerSecond: fixtureTokensPerSecond(),
    tokenSize: { min: 2, max: 6 },
  });
  modelRuntime.registerNativeProvider(fixture.provider);

  const responses = [];
  for (let index = 1; index <= FIXTURE_RESPONSES; index += 1) {
    responses.push(
      scripted(fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" })),
      scripted(
        fauxAssistantMessage(
          `Local fixture response ${index}. Pi streamed this through its real AgentSession.prompt path.`,
        ),
      ),
    );
  }
  fixture.setResponses(responses);
  const model = fixture.getModel(FIXTURE_MODEL);
  if (!model) throw new Error("The local Pi fixture model was not registered.");
  return { modelRuntime, model, tools: ["ls"] };
}

function fixtureTokensPerSecond(): number {
  const raw =
    process.env.AEON_FIXTURE_TOKENS_PER_SECOND ?? process.env.PIPPIN_FIXTURE_TOKENS_PER_SECOND;
  const configured = Number(raw);
  const value = raw ? configured : DEFAULT_TOKENS_PER_SECOND;
  if (!Number.isFinite(value) || value < 1 || value > 100)
    throw new Error("AEON_FIXTURE_TOKENS_PER_SECOND must be between 1 and 100.");
  return value;
}
