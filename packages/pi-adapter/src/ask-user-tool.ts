import { defineTool } from "@earendil-works/pi-coding-agent";
import { browserkitHome, saveProfileValues } from "@browserkit/tools/host";
import { Type, type Static } from "typebox";
import type { ToolText } from "./site-tool-output.js";

// ask_user: the one way the agent asks the user something mid-task. The question shows in the
// chat and, through the chat's needs-you state, on the orb in the tab the user is looking at.
// A yes/no, a pick from choices, or a typed answer; a typed answer can go straight into the form
// profile (`save`), and then only the field's name comes back, never the value.

const WAIT_MS = 15 * 60_000;

const Parameters = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 200 }),
    detail: Type.Optional(
      Type.String({
        maxLength: 1000,
        description: "What the user needs to decide: for a submit, what will be sent and where.",
      }),
    ),
    choices: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), {
        minItems: 2,
        maxItems: 12,
        description: "The user picks one. Leave out for a yes/no question or a typed answer.",
      }),
    ),
    input: Type.Optional(
      Type.Boolean({ description: "true: the user types an answer (a middle name, a date)." }),
    ),
    placeholder: Type.Optional(Type.String({ maxLength: 200 })),
    save: Type.Optional(
      Type.String({
        maxLength: 60,
        description:
          "Form profile field to keep the typed answer in (e.g. 'middleName'). The value goes to the profile, not to you: fill it with bu.fillProfile().",
      }),
    ),
  },
  { additionalProperties: false },
);
type Input = Static<typeof Parameters>;

const GUIDELINES = [
  "ask_user asks the user and waits for the answer: yes/no (just question), one of choices, or a typed answer (input: true). Ask only what you cannot find yourself (their accounts, history, profile and pages come first), and ask once with everything you need.",
  "Before submitting any form (the final Submit, Send, Apply, Book or Pay click), ask_user with what will be sent and where in detail, and submit only on yes.",
  "A form field the profile lacks (bu.fillProfile() reports it missing): ask_user({question: 'Your middle name?', input: true, save: 'middleName'}) keeps it in their form profile without you seeing it; then bu.fillProfile() fills it, now and in every later form.",
];

type Ui = {
  confirm(title: string, message: string, options?: { timeout?: number }): Promise<boolean>;
  select(
    title: string,
    options: string[],
    settings?: { timeout?: number },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    settings?: { timeout?: number },
  ): Promise<string | undefined>;
};

export async function askUser(ui: Ui, input: Input, home = browserkitHome()): Promise<unknown> {
  const question = input.detail ? `${input.question}\n\n${input.detail}` : input.question;
  if (input.choices?.length) {
    const answer = await ui.select(question, input.choices, { timeout: WAIT_MS });
    return answer === undefined ? unanswered() : { answer };
  }
  if (input.input || input.save) return askTyped(ui, question, input, home);
  return { answer: await ui.confirm(input.question, input.detail ?? "", { timeout: WAIT_MS }) };
}

async function askTyped(ui: Ui, question: string, input: Input, home: string): Promise<unknown> {
  const answer = await ui.input(question, input.placeholder, { timeout: WAIT_MS });
  if (answer === undefined || !answer.trim()) return unanswered();
  if (!input.save) return { answer };
  const kept = await saveProfileValues(home, { [input.save]: answer });
  return kept.saved.length
    ? { saved: kept.saved[0], next: "bu.fillProfile() fills it" }
    : { saved: null, refused: kept.refused[0]?.reason ?? "not kept" };
}

function unanswered(): { answer: null; note: string } {
  return {
    answer: null,
    note: "The user did not answer. Do not guess; stop and say what you need.",
  };
}

export function createAskUserTool(): ReturnType<typeof defineTool> {
  return defineTool({
    name: "ask_user",
    label: "Ask",
    description:
      "Ask the user a yes/no question, a choice, or for a typed answer, and wait for it. Required before submitting any form.",
    promptSnippet: "Use ask_user to ask the user something, and before submitting any form.",
    promptGuidelines: GUIDELINES,
    parameters: Parameters,
    execute: async (_toolCallId, input, _signal, _onUpdate, ctx): Promise<ToolText> => {
      const value = ctx.hasUI
        ? await askUser(ctx.ui, input)
        : {
            answer: null,
            note: "No one can answer here (a routine or outside run): do not submit; report what needs the user.",
          };
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
    },
  });
}
