import { defineTool } from "@earendil-works/pi-coding-agent";
import { browserkitHome, saveProfileValues } from "@browserkit/tools/host";
import { Type, type Static } from "typebox";
import type { ToolText } from "./site-tool-output.js";
import { openUserWait, STEERED_NOTE, untilAborted } from "./user-waits.js";

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
  "The user's request is the go-ahead: submit what they asked for (sign up, apply, book, send) without asking to confirm. Ask before a final submit only when it goes beyond the request: a payment they did not mention, a message to people they did not name, or details about them you had to guess.",
  "A test or throwaway account (the user says so): make up the name, birthday and any other detail the site asks for; never ask for them or use the user's real ones. Never make up a phone number: its code would reach a stranger; a site that requires one gets the user's own, via bu.handoff for them to enter it and its code.",
  "A form field the profile lacks (bu.fillProfile() reports it missing): ask_user({question: 'Your middle name?', input: true, save: 'middleName'}) keeps it in their form profile without you seeing it; then bu.fillProfile() fills it, now and in every later form.",
];

type Ui = {
  confirm(
    title: string,
    message: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<boolean>;
  select(
    title: string,
    options: string[],
    settings?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    settings?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
};

export async function askUser(
  ui: Ui,
  input: Input,
  home = browserkitHome(),
  signal?: AbortSignal,
): Promise<unknown> {
  const options = { timeout: WAIT_MS, ...(signal ? { signal } : {}) };
  const question = input.detail ? `${input.question}\n\n${input.detail}` : input.question;
  if (input.choices?.length) {
    const answer = await ui.select(question, input.choices, options);
    return answer === undefined ? unanswered() : { answer };
  }
  if (input.input || input.save) return askTyped(ui, question, input, home, options);
  return { answer: await ui.confirm(input.question, input.detail ?? "", options) };
}

async function askTyped(
  ui: Ui,
  question: string,
  input: Input,
  home: string,
  options: { timeout: number; signal?: AbortSignal },
): Promise<unknown> {
  const answer = await ui.input(question, input.placeholder, options);
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

// A stop or a steer dismisses the question at once (see user-waits.ts).
async function askAndWait(
  chatId: string,
  ui: Ui,
  input: Input,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const wait = openUserWait(chatId, signal);
  try {
    // Raced too, in case a dialog ignores its signal.
    const value = await untilAborted(
      askUser(ui, input, browserkitHome(), wait.signal),
      wait.signal,
      unanswered,
    );
    return wait.steered() ? { answer: null, note: STEERED_NOTE } : value;
  } finally {
    wait.close();
  }
}

export function createAskUserTool(chatId: string): ReturnType<typeof defineTool> {
  return defineTool({
    name: "ask_user",
    label: "Ask",
    description:
      "Ask the user a yes/no question, a choice, or for a typed answer, and wait for it. Required before submitting any form.",
    promptSnippet: "Use ask_user to ask the user something, and before submitting any form.",
    promptGuidelines: GUIDELINES,
    parameters: Parameters,
    execute: async (_toolCallId, input, signal, _onUpdate, ctx): Promise<ToolText> => {
      const value = ctx.hasUI
        ? await askAndWait(chatId, ctx.ui, input, signal)
        : {
            answer: null,
            note: "No one can answer here (a routine or outside run): do not submit; report what needs the user.",
          };
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
    },
  });
}
