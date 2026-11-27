// Compiled site ops: build `api.json` from the site's API model, its abilities (stored and
// built-in) and its helper scripts, and run one op by id. Ability ops run through the ability
// runner, so shape-drift checks, write read-back, versions and the HTTP-then-script fallback all
// still apply; nothing here re-implements them.

import {
  listAbilities,
  runAbility,
  type Ability,
  type AbilityHost,
  type AbilityRunResult,
} from "./abilities.js";
import { operationOutputSchema } from "./output-schema.js";
import type { Operation } from "./types.js";
import { siteName } from "./registry.js";
import { loadCurrentModel } from "./model-refresh.js";
import { refreshSiteSkill } from "./site-notes.js";
import {
  readHelperOps,
  readOpsFile,
  writeOpsFile,
  type SiteOp,
  type SiteOpGuards,
  type SiteOpsFile,
} from "./site-ops-file.js";

export type { SiteOp, SiteOpsFile } from "./site-ops-file.js";

function withOutputSchema(operation: Operation): { outputSchema?: Record<string, unknown> } {
  const schema = operationOutputSchema(operation);
  return schema ? { outputSchema: schema } : {};
}

/** Rebuilds `api.json` (helpers kept as they are) and the ops part of `SKILL.md`. */
export async function compileSiteOps(site: string): Promise<SiteOpsFile> {
  const host = siteName(site);
  const [model, abilities, helpers] = await Promise.all([
    loadCurrentModel(host).catch(() => undefined),
    listAbilities(host).catch(() => [] as Ability[]),
    readHelperOps(host),
  ]);
  const fromAbilities = abilities.map(abilityOp);
  const taken = new Set(fromAbilities.map((op) => op.id));
  const fromApi: SiteOp[] = (model?.operations ?? [])
    .filter((operation) => !taken.has(operation.id))
    .map((operation) => ({
      id: operation.id,
      kind: "http",
      source: "api",
      method: operation.method,
      path: operation.path,
      ...(operation.summary ? { summary: operation.summary } : {}),
      ...withOutputSchema(operation),
    }));
  const file = await writeOpsFile(host, [...fromApi, ...fromAbilities, ...helpers]);
  await refreshSiteSkill(host);
  return file;
}

/**
 * The compiled ops. `model.json` is the source of truth: `api.json` is compiled when missing,
 * and again when the model was rebuilt after it (a live learn, an inference refresh).
 */
export async function readSiteOps(site: string): Promise<SiteOpsFile> {
  const [file, model] = await Promise.all([
    readOpsFile(site),
    loadCurrentModel(siteName(site)).catch(() => undefined),
  ]);
  if (file && !(model && Date.parse(model.generatedAt) > Date.parse(file.compiledAt))) return file;
  return compileSiteOps(site);
}

export function abilityOp(ability: Ability): SiteOp {
  const via = ability.ways.map((way) => way.kind);
  const http = via.includes("api");
  const guards = guardsOf(ability);
  return {
    id: ability.name,
    kind: http ? "http" : "script",
    source: ability.createdBy === "builtin" ? "builtin" : "ability",
    ability: ability.name,
    via,
    ...(http && via.some((kind) => kind !== "api") ? { fallback: true } : {}),
    ...(ability.description ? { summary: ability.description } : {}),
    ...(ability.version ? { version: ability.version } : {}),
    effect: ability.effect ?? ability.kind,
    ...(Object.keys(guards).length ? { guards } : {}),
  };
}

function guardsOf(ability: Ability): SiteOpGuards {
  const expect = ability.ways
    .map((way) => (way.kind === "steps" ? undefined : way.expect))
    .find((item) => item !== undefined);
  const readBack = ability.postcondition?.ability ?? ability.options.readBack?.ability;
  return {
    ...(expect?.shape ? { shape: expect.shape } : {}),
    ...(expect?.list ? { list: expect.list } : {}),
    ...(readBack ? { readBack } : {}),
  };
}

export interface SiteOpRun {
  op: SiteOp;
  result: unknown;
  /** Ability ops: the full run, with drift, read-back and fallback details. */
  run?: AbilityRunResult;
}

/** Runs one compiled op. No model is involved at any point. */
export async function runSiteOp(
  site: string,
  id: string,
  inputs: Record<string, unknown> = {},
  host?: AbilityHost,
): Promise<SiteOpRun> {
  const op = (await readSiteOps(site)).ops.find((item) => item.id === id);
  if (!op) throw new Error(`OP_UNKNOWN: ${siteName(site)} has no op ${id}`);
  if (op.ability) {
    const run = await runAbility(site, op.ability, inputs, host ? { host } : {});
    return { op, result: run.result, run };
  }
  if (op.source === "helper") {
    if (!host?.script) throw new Error(`OP_NEEDS_PAGE: ${id} is a script helper`);
    return { op, result: await host.script(op.code ?? "", inputs) };
  }
  if (!host?.call) throw new Error(`OP_NEEDS_HOST: ${id} calls the site's API`);
  return { op, result: await host.call(id, inputs) };
}
