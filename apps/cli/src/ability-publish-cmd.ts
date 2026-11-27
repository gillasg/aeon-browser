// `graft abilities publish|review`: the shareable definition and its deterministic checks, plus an
// optional model review as a separate command. Nothing here runs on a save or a run.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { completeWithDefaultModel } from "@graft/pi-adapter";
import {
  createRedactor,
  formatFinding,
  lintPublicAbility,
  parseReview,
  publicAbility,
  publishErrors,
  readAbility,
  reviewPrompt,
  reviewSystem,
  REVIEW_MODEL,
  type Ability,
} from "@browserkit/site-mapper";
import { flag, has, type Args } from "browserkit/dist/args.js";
import { printJson } from "browserkit/dist/output.js";
import { modelAuthPath } from "./doctor-io.js";

/** Prints the public definition and its lint; exits non-zero when an error blocks a share. */
export async function publishAbility(site: string, name: string, args: Args): Promise<number> {
  const ability = await readAbility(site, name);
  if (!ability) throw new Error(`No ability ${JSON.stringify(name)} on ${site}`);
  const definition = createRedactor().json(publicAbility(ability));
  const findings = lintPublicAbility(ability);
  const errors = publishErrors(findings);
  if (has(args, "json")) {
    printJson({ definition, findings });
    return errors.length ? 1 : 0;
  }
  if (errors.length) {
    processFindings(findings);
    process.stdout.write("Not publishable: fix the errors above, or share it unreviewed.\n");
    return 1;
  }
  const out = flag(args, "out");
  if (typeof out === "string" && out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(definition, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(definition, null, 2) + "\n");
  processFindings(findings);
  return 0;
}

/** The optional model review: deterministic errors stop it before any model call. */
export async function reviewAbility(site: string, name: string, args: Args): Promise<number> {
  const ability = await readAbility(site, name);
  if (!ability) throw new Error(`No ability ${JSON.stringify(name)} on ${site}`);
  const errors = publishErrors(lintPublicAbility(ability));
  if (errors.length) {
    processFindings(errors);
    process.stdout.write("Fix the errors above before the model review.\n");
    return 1;
  }
  const text = await completeReview(ability);
  const review = parseReview(text);
  if (has(args, "json")) {
    printJson(review);
  } else {
    process.stdout.write(`${review.verdict.toUpperCase()} ${site} ${name}\n`);
    for (const finding of review.findings)
      process.stdout.write(`- ${finding.path ? `${finding.path}: ` : ""}${finding.note}\n`);
  }
  return review.verdict === "allow" ? 0 : 1;
}

async function completeReview(ability: Ability): Promise<string> {
  const session = await mkdtemp(join(tmpdir(), "graft-ability-review-"));
  try {
    return await completeWithDefaultModel(
      {
        sessionDirectory: session,
        agentDirectory: dirname(modelAuthPath()),
        preferredInitialModel: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      },
      reviewSystem(),
      [{ role: "user", content: reviewPrompt(ability) }],
      { model: REVIEW_MODEL, thinking: "low" },
    );
  } finally {
    await rm(session, { recursive: true, force: true });
  }
}

function processFindings(findings: ReturnType<typeof lintPublicAbility>): void {
  for (const finding of findings) process.stdout.write(formatFinding(finding) + "\n");
}
