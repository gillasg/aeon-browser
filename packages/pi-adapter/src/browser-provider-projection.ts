import type { createAgentSession } from "@earendil-works/pi-coding-agent";
type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
export function installBrowserControlRequestProjection(session: Session): void {
  const runner = session.extensionRunner as unknown as {
    hasHandlers: (eventType: string) => boolean;
    emitBeforeProviderRequest: (payload: unknown) => Promise<unknown>;
  };
  const hasHandlers = runner.hasHandlers.bind(runner);
  const emitBeforeProviderRequest = runner.emitBeforeProviderRequest.bind(runner);
  runner.hasHandlers = (eventType) =>
    eventType === "before_provider_request" || hasHandlers(eventType);
  runner.emitBeforeProviderRequest = async (payload) => {
    const emitted = await emitBeforeProviderRequest(payload);
    const request = isRecord(emitted) ? emitted : isRecord(payload) ? payload : undefined;
    if (!request || !isCodex(session)) return emitted;
    const tools = Array.isArray(request.tools) ? [...request.tools] : [];
    for (const name of session.getActiveToolNames()) {
      if (
        tools.some(
          (tool) =>
            isRecord(tool) &&
            (tool.name === name || (isRecord(tool.function) && tool.function.name === name)),
        )
      )
        continue;
      const definition = session.getToolDefinition(name);
      if (
        !isRecord(definition) ||
        typeof definition.description !== "string" ||
        !isRecord(definition.parameters)
      )
        continue;
      tools.push({
        type: "function",
        name,
        description: definition.description,
        parameters: definition.parameters,
      });
    }
    return { ...request, tools };
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodex(session: Session): boolean {
  return (
    session.model?.provider === "openai-codex" && session.model.api === "openai-codex-responses"
  );
}
