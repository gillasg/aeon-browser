import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { OpenPiSessionInput, PiSessionHandle } from "@pippin/domain";
export function verifyCachedHandle(
  handle: PiSessionHandle,
  input: OpenPiSessionInput,
): PiSessionHandle {
  if (handle.reference.sessionId !== input.activationId)
    throw new Error("A different Pi session is already attached to this Chat in the daemon.");
  return handle;
}
export async function setInitialModel(
  session: AgentSession,
  input: OpenPiSessionInput,
  preferred: { provider: string; id: string } | undefined,
  fixture: unknown,
): Promise<void> {
  if (!input.reference && preferred && !fixture) {
    const { provider, id } = preferred;
    const model = session.modelRuntime
      .getAvailableSnapshot()
      .find((candidate) => candidate.provider === provider && candidate.id === id);
    if (!model) {
      session.dispose();
      throw new Error(`Aeon's preferred Pi model ${provider}/${id} is not available.`);
    }
    await session.setModel(model, { persist: false });
  }
}
