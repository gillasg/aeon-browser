// graft abilities keeps browserkit's abilities command and adds test --all, rename, forget,
// versions/restore and the publish tools.

import {
  forgetAbility,
  listAbilityVersions,
  renameAbility,
  restoreAbility,
  testAllAbilities,
} from "@browserkit/site-mapper";
import { has, type Args } from "browserkit/dist/args.js";
import { printJson } from "browserkit/dist/output.js";
import type { Command } from "browserkit/dist/usage.js";
import { publishAbility, reviewAbility } from "./ability-publish-cmd.js";

export function abilitiesCommand(original: Command): Command {
  return {
    ...original,
    summary: "list, run, test, rename, version, restore, publish and forget saved abilities",
    help: `${original.help}

  test --all                 every saved ability's stored tests, offline
  rename <site> <from> <to>  rename one
  forget <site> <name>       drop one
  versions <site> <name>     earlier saved content, newest first
  restore <site> <name> <at> make an earlier version live again (same contract checks)
  publish <site> <name> [--out <file>] [--json]
                              the definition a caller sees, plus the share lint
  review <site> <name> [--json]
                              one model read of the claims; separate and optional`,
    run: (args) => dispatch(original, args),
  };
}

type Handler = (
  site: string | undefined,
  from: string | undefined,
  to: string | undefined,
  args: Args,
) => Promise<number | undefined>;

const VERBS: Record<string, Handler> = {
  rename: async (site, from, to) => (site && from && to ? rename(site, from, to) : undefined),
  forget: async (site, from) => (site && from ? forget(site, from) : undefined),
  versions: async (site, from, _to, args) =>
    site && from ? versions(site, from, has(args, "json")) : undefined,
  restore: async (site, from, to, args) =>
    site && from && to ? restore(site, from, to, has(args, "breaking")) : undefined,
  publish: async (site, from, _to, args) =>
    site && from ? publishAbility(site, from, args) : undefined,
  review: async (site, from, _to, args) =>
    site && from ? reviewAbility(site, from, args) : undefined,
};

async function dispatch(original: Command, args: Args): Promise<number> {
  const [verb, site, from, to] = args.positional;
  if (verb === "test" && has(args, "all")) return testAll();
  const handler = verb ? VERBS[verb] : undefined;
  const result = handler ? await handler(site, from, to, args) : undefined;
  return result ?? original.run(args);
}

async function versions(site: string, name: string, json: boolean): Promise<number> {
  const rows = await listAbilityVersions(site, name);
  if (json) {
    printJson(rows);
    return 0;
  }
  if (!rows.length) {
    process.stdout.write(`${site} ${name} has no earlier versions.\n`);
    return 0;
  }
  for (const row of rows)
    process.stdout.write(
      `${row.at}\t${row.ways.join("+") || "-"}\t${row.bytes} bytes${
        row.updatedAt ? `\tsaved ${row.updatedAt}` : ""
      }\n`,
    );
  return 0;
}

async function restore(site: string, name: string, at: string, breaking: boolean): Promise<number> {
  const saved = await restoreAbility(site, name, at, breaking ? { breaking: true } : {});
  process.stdout.write(`restored ${saved.ability.site} ${saved.ability.name} from ${at}\n`);
  for (const warning of saved.warnings) process.stdout.write(`note: ${warning}\n`);
  return 0;
}

async function testAll(): Promise<number> {
  const rows = await testAllAbilities({ dry: true });
  const failed = rows.filter((row) => !row.ok);
  for (const row of rows)
    if (!row.skipped)
      process.stdout.write(
        `${row.ok ? "ok" : "fail"} ${row.site} ${row.name}${row.error ? ` ${row.error}` : ""}\n`,
      );
  process.stdout.write(`${rows.length} abilities, ${failed.length} failed\n`);
  return failed.length ? 1 : 0;
}

async function rename(site: string, from: string, to: string): Promise<number> {
  const ability = await renameAbility(site, from, to);
  process.stdout.write(`${ability.site} ${ability.name}\n`);
  return 0;
}

async function forget(site: string, name: string): Promise<number> {
  const removed = await forgetAbility(site, name);
  process.stdout.write(removed ? `forgot ${name}\n` : `no ability ${name}\n`);
  return removed ? 0 : 1;
}
