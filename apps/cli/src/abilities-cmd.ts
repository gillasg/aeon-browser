// aeon abilities keeps browserkit's abilities command and adds test --all, rename and forget.

import { forgetAbility, renameAbility, testAllAbilities } from "@browserkit/site-mapper";
import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";

export function abilitiesCommand(original: Command): Command {
  return {
    ...original,
    summary: "list, run, test, rename and forget saved abilities",
    help: `${original.help}

  test --all                 every saved ability's stored tests, offline
  rename <site> <from> <to>  rename one
  forget <site> <name>       drop one`,
    run: (args) => dispatch(original, args),
  };
}

async function dispatch(original: Command, args: Args): Promise<number> {
  const [verb, site, from, to] = args.positional;
  if (verb === "test" && has(args, "all")) return testAll();
  if (verb === "rename" && site && from && to) return rename(site, from, to);
  if (verb === "forget" && site && from) return forget(site, from);
  return original.run(args);
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
