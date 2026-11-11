import { errorOwner, leadingCode } from "@aeon/protocol";

const TITLES = {
  page: "The site blocked this",
  user: "I need you for one step",
  model: "That was my mistake",
  ours: "Aeon broke",
} as const;

/** Title for a failed run. An unknown or missing code belongs to us. */
export function failureTitle(error: string): string {
  const code = leadingCode(error);
  return TITLES[code ? errorOwner(code) : "ours"];
}
