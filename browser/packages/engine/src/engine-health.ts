import { ENGINE_PROTOCOL_VERSION } from "@browserkit/protocol";

export interface EngineHealth {
  nonce: string;
  protocolVersion: { major: number; minor: number };
}

/**
 * Answers on a later event-loop turn. A blocked extension never looks healthy: the daemon's
 * budget expires before this timer can run.
 */
export function healthTurn(message: Record<string, unknown>): Promise<EngineHealth> {
  const nonce = typeof message.nonce === "string" ? message.nonce : "";
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        nonce,
        protocolVersion: {
          major: ENGINE_PROTOCOL_VERSION.major,
          minor: ENGINE_PROTOCOL_VERSION.minor,
        },
      });
    }, 0);
  });
}
