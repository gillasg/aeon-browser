import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssistantMessage, Tool } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { boundedResult, errorResult, type ToolText } from "./site-tool-output.js";
import { defaultModel, type CompletionOptions } from "./text-completion.js";

// extract: messy text (a page, a crawl, messages, a file) in, JSON that matches a schema out.
// The model answers through a tool whose parameters are the schema, with constrained sampling
// where the provider has it; the answer is checked against the schema and retried on a miss.

const MAX_INPUT = 400_000;
const ATTEMPTS = 3;

const Parameters = Type.Object(
  {
    schema: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "JSON Schema of the result, e.g. {type:'array', items:{type:'object', properties:{name:{type:'string'}, price:{type:'number'}}, required:['name']}}",
    }),
    text: Type.Optional(Type.String({ description: "The text to extract from." })),
    file: Type.Optional(
      Type.String({ maxLength: 500, description: "Or a file in the workspace to read." }),
    ),
    instructions: Type.Optional(Type.String({ maxLength: 4000 })),
    model: Type.Optional(
      Type.String({ maxLength: 200, description: "provider/id; default is the chat default." }),
    ),
  },
  { additionalProperties: false },
);
type Input = Static<typeof Parameters>;

const GUIDELINES = [
  "extract turns text (a page's markdown, a crawl file, messages, a document) into JSON that always matches the schema you give: lists of products, listings, contacts, prices, events. Use it instead of hand-parsing in code when the text is messy or varies. Pass text, or file for something saved in the workspace; a cheaper model suits large batches.",
];

async function source(input: Input, workspace: string | undefined): Promise<string> {
  if (input.text) return input.text.slice(0, MAX_INPUT);
  if (!input.file) throw new Error("Give text, or file (a path in the workspace)");
  if (!workspace) throw new Error("This chat has no workspace");
  const path = resolve(workspace, input.file);
  if (!path.startsWith(resolve(workspace))) throw new Error("file must be inside the workspace");
  return (await readFile(path, "utf8")).slice(0, MAX_INPUT);
}

type Schema = { properties?: Record<string, Schema>; required?: string[]; items?: Schema };

/** Strict sampling makes optional fields nullable: a null there means the text did not say. */
function dropNulls(value: unknown, schema: Schema | undefined): unknown {
  if (Array.isArray(value)) return value.map((item) => dropNulls(item, schema?.items));
  if (!value || typeof value !== "object" || !schema?.properties) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, field]) => field !== null || schema.required?.includes(key))
      .map(([key, field]) => [key, dropNulls(field, schema.properties?.[key])]),
  );
}

function answerOf(reply: AssistantMessage): unknown {
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    throw new Error(reply.errorMessage ?? "the model failed");
  const call = reply.content.find((part) => part.type === "toolCall");
  if (call) return (call.arguments as { result?: unknown }).result;
  const text = reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const json = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  try {
    return (JSON.parse(json) as { result?: unknown }).result ?? JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Runs the extraction; the result matches the schema or this throws. */
export async function extractJson(
  options: CompletionOptions,
  schema: Record<string, unknown>,
  text: string,
  instructions = "",
  model?: string,
): Promise<unknown> {
  const { runtime, model: chosen } = await defaultModel(options, model ? { model } : {});
  const tool: Tool = {
    name: "submit_result",
    description: "Submit the extracted result.",
    parameters: {
      type: "object",
      properties: { result: schema },
      required: ["result"],
      additionalProperties: false,
    } as unknown as TSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
  let problems = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const reply = await runtime.completeSimple(chosen, {
      systemPrompt:
        "Extract the requested data from the user's text. Answer only by calling submit_result with the result. Use only what the text says; leave optional fields out when it does not say.",
      tools: [tool],
      messages: [
        {
          role: "user",
          content: `${instructions ? `${instructions}\n\n` : ""}${problems}Text:\n\n${text}`,
          timestamp: Date.now(),
        },
      ],
    });
    const result = dropNulls(answerOf(reply), schema as Schema);
    if (result !== undefined && Value.Check(schema, result)) return result;
    const errors = [...Value.Errors(schema, result)].slice(0, 10).map((e) => e.message);
    problems = `Your previous answer did not match the schema (${errors.join("; ") || "no result"}). Answer again.\n\n`;
  }
  throw new Error(`The model did not return data matching the schema. ${problems.trim()}`);
}

export function createExtractTool(
  options: CompletionOptions,
  workspace?: string,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "extract",
    label: "Extract",
    description: "Turn text or a workspace file into JSON that matches a JSON Schema.",
    promptSnippet: "Use extract to turn messy text into structured JSON.",
    promptGuidelines: GUIDELINES,
    parameters: Parameters,
    execute: async (_toolCallId, input): Promise<ToolText> => {
      try {
        const value = await extractJson(
          options,
          input.schema,
          await source(input, workspace),
          input.instructions,
          input.model,
        );
        return boundedResult(value, workspace, "extract", "result");
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
