import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  HelloAckSchema,
  HelloRejectionSchema,
  HelloSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type HelloRejection,
  type ProtocolHandshakeMessage,
} from "@aeon/protocol";

export type HandshakeDecision =
  | { accepted: true; response: ProtocolHandshakeMessage }
  | { accepted: false; response: HelloRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(code: HelloRejection["code"]): HandshakeDecision {
  return {
    accepted: false,
    response: HelloRejectionSchema.parse({
      kind: "hello.reject",
      stage: "handshake",
      code,
      supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
    }),
  };
}

function matchesGrant(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}

export function negotiateHello(
  candidate: unknown,
  expectedGrant: string,
  connectionId = randomUUID(),
): HandshakeDecision {
  if (!isRecord(candidate) || candidate.kind !== "hello") return reject("MALFORMED_HELLO");

  const version = candidate.protocolVersion;
  if (!isRecord(version) || !Object.hasOwn(version, "major")) {
    return reject("PROTOCOL_VERSION_REQUIRED");
  }

  const parsed = HelloSchema.safeParse(candidate);
  if (!parsed.success) return reject("INVALID_HELLO");

  const hello = parsed.data;
  if (hello.protocolVersion.major !== SUPPORTED_PROTOCOL_VERSION.major) {
    return reject("UNSUPPORTED_PROTOCOL_MAJOR");
  }
  if (hello.protocolVersion.minor > SUPPORTED_PROTOCOL_VERSION.minor) {
    return reject("UNSUPPORTED_PROTOCOL_MINOR");
  }
  if (!matchesGrant(hello.connectionGrant, expectedGrant)) return reject("AUTHENTICATION_FAILED");
  if (hello.role === "desktop-ui") return reject("ROLE_NOT_AVAILABLE");

  return {
    accepted: true,
    response: HelloAckSchema.parse({
      kind: "hello.ack",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      role: hello.role,
      connectionId,
    }),
  };
}

export function rejectPrivilegedMessage(): HelloRejection {
  return HelloRejectionSchema.parse({
    kind: "hello.reject",
    stage: "message",
    code: "PRIVILEGED_COMMANDS_DISABLED",
    supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
  });
}
