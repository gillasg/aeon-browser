import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const FIXTURE_PROVIDER = "pippin-local-fixture";
const FIXTURE_MODEL = "read-only-stream";
const FIXTURE_RESPONSES = 64;
const DEFAULT_TOKENS_PER_SECOND = 35;

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
    api: "pippin-local-faux",
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
      fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        `Local fixture response ${index}. Pi streamed this through its real AgentSession.prompt path.`,
      ),
    );
  }
  fixture.setResponses(responses);
  const model = fixture.getModel(FIXTURE_MODEL);
  if (!model) throw new Error("The local Pi fixture model was not registered.");
  return { modelRuntime, model, tools: ["ls"] };
}

function fixtureTokensPerSecond(): number {
  const configured = Number(process.env.PIPPIN_FIXTURE_TOKENS_PER_SECOND);
  const value = process.env.PIPPIN_FIXTURE_TOKENS_PER_SECOND
    ? configured
    : DEFAULT_TOKENS_PER_SECOND;
  if (!Number.isFinite(value) || value < 1 || value > 100)
    throw new Error("PIPPIN_FIXTURE_TOKENS_PER_SECOND must be between 1 and 100.");
  return value;
}
