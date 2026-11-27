import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { OpenPiSessionInput, PiSessionHandle } from "@graft/domain";
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
  // Graft's preferred model only fills in when the person has not chosen a default, and only when
  // it is connected; otherwise Pi's own choice (their default, else the first connected) stands.
  if (input.reference || !preferred || fixture) return;
  const settings = session.settingsManager;
  if (settings.getDefaultProvider() && settings.getDefaultModel()) return;
  const model = session.modelRuntime
    .getAvailableSnapshot()
    .find(
      (candidate) => candidate.provider === preferred.provider && candidate.id === preferred.id,
    );
  if (model) await session.setModel(model, { persist: false });
}
