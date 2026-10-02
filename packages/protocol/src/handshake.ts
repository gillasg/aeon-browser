import { z } from "zod";

export const SUPPORTED_PROTOCOL_VERSION = { major: 1, minor: 6 } as const;

export const ClientRoleSchema = z.enum(["ui", "extension-executor", "desktop-ui"]);
export type ClientRole = z.infer<typeof ClientRoleSchema>;

export const ProtocolVersionSchema = z
  .object({
    major: z.number().int().positive(),
    minor: z.number().int().nonnegative(),
  })
  .strict();
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const HelloSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: ProtocolVersionSchema,
    role: ClientRoleSchema,
    clientInstanceId: z.string().uuid().optional(),
    browserRunId: z.string().uuid().optional(),
    connectionGrant: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type Hello = z.infer<typeof HelloSchema>;

export const HelloAckSchema = z
  .object({
    kind: z.literal("hello.ack"),
    protocolVersion: ProtocolVersionSchema,
    role: ClientRoleSchema,
    connectionId: z.string().uuid(),
  })
  .strict();
export type HelloAck = z.infer<typeof HelloAckSchema>;

export const HelloRejectionSchema = z
  .object({
    kind: z.literal("hello.reject"),
    stage: z.enum(["handshake", "message"]),
    code: z.enum([
      "MALFORMED_HELLO",
      "PROTOCOL_VERSION_REQUIRED",
      "INVALID_HELLO",
      "UNSUPPORTED_PROTOCOL_MAJOR",
      "UNSUPPORTED_PROTOCOL_MINOR",
      "AUTHENTICATION_FAILED",
      "ORIGIN_NOT_ALLOWED",
      "ROLE_NOT_AVAILABLE",
      "PRIVILEGED_COMMANDS_DISABLED",
    ]),
    supportedProtocolVersion: ProtocolVersionSchema,
  })
  .strict();
export type HelloRejection = z.infer<typeof HelloRejectionSchema>;

export const ProtocolHandshakeMessageSchema = z.discriminatedUnion("kind", [
  HelloSchema,
  HelloAckSchema,
  HelloRejectionSchema,
]);
export type ProtocolHandshakeMessage = z.infer<typeof ProtocolHandshakeMessageSchema>;
