import { Type, type TSchema } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface ThreadToolHost {
  execute(chatId: string, toolCallId: string, toolName: string, input: unknown): Promise<string>;
}

const createParameters = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }),
    model: Type.Optional(
      Type.String({
        maxLength: 200,
        description:
          "provider/id for this thread (default: the chat default). A cheaper model suits bulk work.",
      }),
    ),
    thinking: Type.Optional(
      Type.Union(
        ["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => Type.Literal(level)),
      ),
    ),
  },
  { additionalProperties: false },
);
const listParameters = Type.Object({}, { additionalProperties: false });
const sendParameters = Type.Object(
  {
    threadId: Type.String({ format: "uuid" }),
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
    inReplyTo: Type.Optional(Type.String({ format: "uuid" })),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }),
  },
  { additionalProperties: false },
);
const readParameters = Type.Object(
  {
    threadId: Type.String({ format: "uuid" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const waitParameters = Type.Object(
  {
    deliveries: Type.Array(
      Type.Object(
        {
          threadId: Type.String({ format: "uuid" }),
          deliveryId: Type.String({ format: "uuid" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8 },
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
  },
  { additionalProperties: false },
);
const forkParameters = Type.Object(
  {
    threadId: Type.String({ format: "uuid" }),
    entryId: Type.String({ minLength: 1, maxLength: 160 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }),
  },
  { additionalProperties: false },
);
const titleParameters = Type.Object(
  {
    threadId: Type.String({ format: "uuid" }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);

export function createThreadTools(
  chatId: string,
  host?: ThreadToolHost,
): ReturnType<typeof defineTool>[] {
  return [
    tool(
      chatId,
      host,
      "create_thread",
      "Create a new independent chat thread, optionally with its own model and thinking level, to hand off work and steer it with send_message_to_thread.",
      createParameters,
    ),
    tool(chatId, host, "list_threads", "List chat threads.", listParameters),
    tool(
      chatId,
      host,
      "send_message_to_thread",
      "Send a causally linked message to another chat thread.",
      sendParameters,
    ),
    tool(
      chatId,
      host,
      "read_thread",
      "Read a bounded Pi transcript snapshot from a chat thread.",
      readParameters,
    ),
    tool(
      chatId,
      host,
      "wait_threads",
      "Wait for exact thread delivery IDs to settle, with a bounded timeout.",
      waitParameters,
    ),
    tool(
      chatId,
      host,
      "fork_thread",
      "Create a detached Pi session fork at an exact transcript entry.",
      forkParameters,
    ),
    tool(chatId, host, "set_thread_title", "Change the title of a chat thread.", titleParameters),
  ];
}

function tool(
  chatId: string,
  host: ThreadToolHost | undefined,
  name: string,
  description: string,
  parameters: TSchema,
): ReturnType<typeof defineTool> {
  return defineTool({
    name,
    label: name.replaceAll("_", " "),
    description,
    parameters,
    execute: async (toolCallId, input) => {
      const result = host
        ? await host.execute(chatId, toolCallId, name, input)
        : JSON.stringify({ error: "THREAD_COORDINATION_OFFLINE" });
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  });
}
