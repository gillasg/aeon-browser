// `aeon record shoot <plan.json>`: a whole walkthrough from a declarative plan. Every scene is its
// own take (its own folder); its steps open pages, drive Aeon's UI, run real prompts, mark beats,
// wait on real conditions and hold still. Capture always stops in `finally`, so a failed step
// never leaves ffmpeg running. With --assemble (or an --out ending in .mp4) the takes are cut
// into one MP4 by `aeon record assemble`.
import type { UiAction } from "./record-ui.js";
import { isUiAction, UI_ACTIONS } from "./record-ui.js";

export type ShootStep =
  | { open: string }
  | { ui: UiAction; mark?: string }
  | { run: string; tail?: number; background?: boolean; timeout?: number }
  | { mark: string; label?: string; selector?: string; box?: string; cue?: string }
  | {
      wait: "selector" | "url" | "idle" | "chat";
      selector?: string;
      url?: string;
      chat?: string;
      timeout?: number;
    }
  | { hold: number }
  | { reload: true }
  | { terminal: string }
  | { code: string; timeout?: number };

/** prepare runs before the camera rolls, so a take opens on its framed first state. */
export type ShootScene = { name: string; prepare?: ShootStep[]; steps: ShootStep[] };
export type ShootPlan = { scenes: ShootScene[]; out?: string; browser?: string; fps?: number };

const CUES = ["key", "trigger", "arrive", "shutter"];
const WAITS = ["selector", "url", "idle", "chat"];

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optStr = (v: unknown) => v === undefined || typeof v === "string";
const optNum = (v: unknown) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** One step in its long form (`{"open": {"url": …}}`) or short form (`{"open": "…"}`). */
function stepOf(raw: unknown, where: string): ShootStep {
  if (!isObject(raw)) throw new Error(`${where}: a step is an object like {"open": "https://…"}`);
  // A ui step may carry a mark ({"ui": "cursor", "mark": "summon"}): there mark is a parameter.
  const keys = Object.keys(raw).filter((k) => STEP_PARSERS[k] && !(k === "mark" && "ui" in raw));
  if (keys.length !== 1)
    throw new Error(`${where}: name exactly one of ${Object.keys(STEP_PARSERS).join(", ")}`);
  const kind = keys[0] ?? "";
  const body = raw[kind];
  const params: Raw = isObject(body) ? { ...raw, ...body } : raw;
  const parse = STEP_PARSERS[kind];
  if (!parse) throw new Error(`${where}: unknown step`);
  return parse(body, params, where);
}

type Parser = (body: unknown, p: Raw, where: string) => ShootStep;

const need = (ok: boolean, where: string, what: string) => {
  if (!ok) throw new Error(`${where}: ${what}`);
};

const STEP_PARSERS: Record<string, Parser> = {
  open: (body, p, where) => {
    const url = str(body) ? body : p.url;
    need(str(url), where, "open needs a url");
    return { open: url as string };
  },
  ui: (body, p, where) => {
    const action = str(body) ? body : p.action;
    need(isUiAction(action as string), where, `ui is one of ${UI_ACTIONS.join(", ")}`);
    need(optStr(p.mark), where, "ui mark is a name");
    return { ui: action as UiAction, ...(str(p.mark) ? { mark: p.mark } : {}) };
  },
  run: (body, p, where) => {
    const prompt = str(body) ? body : p.prompt;
    need(str(prompt), where, "run needs a prompt");
    need(optNum(p.tail) && optNum(p.timeout), where, "tail and timeout are numbers");
    return {
      run: prompt as string,
      ...(p.tail !== undefined ? { tail: p.tail as number } : {}),
      ...(p.background === true ? { background: true } : {}),
      ...(p.timeout !== undefined ? { timeout: p.timeout as number } : {}),
    };
  },
  mark: (body, p, where) => {
    const name = str(body) ? body : p.name;
    need(str(name), where, "mark needs a name");
    need(
      p.cue === undefined || CUES.includes(p.cue as string),
      where,
      `cue is one of ${CUES.join(", ")}`,
    );
    need(
      optStr(p.label) && optStr(p.selector) && optStr(p.box),
      where,
      "label, selector and box are strings",
    );
    const pick = (k: string) => (str(p[k]) ? { [k]: p[k] as string } : {});
    return {
      mark: name as string,
      ...pick("label"),
      ...pick("selector"),
      ...pick("box"),
      ...pick("cue"),
    };
  },
  wait: (body, p, where) => {
    const kind = str(body) ? body : p.for;
    need(WAITS.includes(kind as string), where, `wait is for ${WAITS.join("|")}`);
    const param = kind === "idle" ? true : str(p[kind as string]);
    need(param, where, `wait for ${String(kind)} needs "${String(kind)}"`);
    need(optNum(p.timeout), where, "timeout is a number");
    const pick = (k: string) => (str(p[k]) ? { [k]: p[k] as string } : {});
    return {
      wait: kind as "idle",
      ...pick("selector"),
      ...pick("url"),
      ...pick("chat"),
      ...(p.timeout !== undefined ? { timeout: p.timeout as number } : {}),
    };
  },
  hold: (body, p, where) => {
    const ms = typeof body === "number" ? body : p.ms;
    need(typeof ms === "number" && ms >= 0 && Number.isFinite(ms), where, "hold needs ms");
    return { hold: ms as number };
  },
  reload: () => ({ reload: true }),
  terminal: (body, p, where) => {
    const command = str(body) ? body : p.run;
    need(str(command), where, "terminal needs a command to run");
    return { terminal: command as string };
  },
  code: (body, p, where) => {
    const js = str(body) ? body : p.js;
    need(str(js), where, "code needs js");
    need(optNum(p.timeout), where, "timeout is a number");
    return {
      code: js as string,
      ...(p.timeout !== undefined ? { timeout: p.timeout as number } : {}),
    };
  },
};

// Before the camera rolls there is no clip clock to mark, no take to attach a terminal or a chat to.
const PREPARE = ["open", "ui", "wait", "hold", "reload", "code"];

function prepareStep(raw: unknown, where: string): ShootStep {
  const step = stepOf(raw, where);
  const kind = Object.keys(step)[0] ?? "";
  if (!PREPARE.includes(kind) || "mark" in step)
    throw new Error(
      `${where}: prepare runs before recording starts, so it takes ${PREPARE.join(", ")} (no marks)`,
    );
  return step;
}

/** Parses and checks a whole plan up front, so a typo fails before anything is filmed. */
export function parsePlan(raw: unknown): ShootPlan {
  if (!isObject(raw) || !Array.isArray(raw.scenes) || raw.scenes.length === 0)
    throw new Error('A plan is {"scenes": [{"name": "…", "steps": […]}]} with at least one scene');
  const names = new Set<string>();
  const scenes = raw.scenes.map((scene: unknown, i): ShootScene => {
    const where = `scenes[${i}]`;
    if (!isObject(scene) || !str(scene.name) || !Array.isArray(scene.steps))
      throw new Error(`${where}: a scene has a name and steps[]`);
    if (names.has(scene.name)) throw new Error(`${where}: scene "${scene.name}" is named twice`);
    names.add(scene.name);
    if (scene.prepare !== undefined && !Array.isArray(scene.prepare))
      throw new Error(`${where}: prepare is a list of steps`);
    const prepare = (scene.prepare ?? []).map((s, j) => prepareStep(s, `${where}.prepare[${j}]`));
    return {
      name: scene.name,
      ...(prepare.length ? { prepare } : {}),
      steps: scene.steps.map((s, j) => stepOf(s, `${where}.steps[${j}]`)),
    };
  });
  return {
    scenes,
    ...(str(raw.out) ? { out: raw.out } : {}),
    ...(str(raw.browser) ? { browser: raw.browser } : {}),
    ...(typeof raw.fps === "number" ? { fps: raw.fps } : {}),
  };
}

/** A scene's folder name: its index and a slug, so takes sort in story order. */
export function sceneFolder(index: number, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "scene";
  return `${String(index + 1).padStart(2, "0")}-${slug}`;
}

/** What a shoot needs from the world; the command wires these to the real recorder. */
export type ShootDeps = {
  start(folder: string): Promise<void>;
  stop(folder: string, chatId: string | undefined): Promise<void>;
  open(url: string): Promise<void>;
  ui(action: UiAction, folder: string, mark: string | undefined): Promise<void>;
  run(folder: string, step: Extract<ShootStep, { run: string }>): Promise<string | undefined>;
  mark(folder: string, step: Extract<ShootStep, { mark: string }>): Promise<void>;
  wait(folder: string, step: Extract<ShootStep, { wait: string }>): Promise<void>;
  hold(ms: number): Promise<void>;
  reload(): Promise<void>;
  terminal(folder: string, command: string): Promise<void>;
  code(js: string, timeoutMs: number | undefined): Promise<void>;
  join(dir: string, name: string): string;
  log(line: string): void;
};

async function runStep(
  step: ShootStep,
  folder: string,
  deps: ShootDeps,
): Promise<string | undefined> {
  if ("open" in step) await deps.open(step.open);
  else if ("ui" in step) await deps.ui(step.ui, folder, step.mark);
  else if ("run" in step) return deps.run(folder, step);
  else if ("mark" in step) await deps.mark(folder, step);
  else if ("wait" in step) await deps.wait(folder, step);
  else if ("hold" in step) await deps.hold(step.hold);
  else if ("reload" in step) await deps.reload();
  else if ("terminal" in step) await deps.terminal(folder, step.terminal);
  else await deps.code(step.code, step.timeout);
  return undefined;
}

/** Films every scene in order. Returns the take folders; a failing step still stops its take. */
export async function shoot(plan: ShootPlan, outDir: string, deps: ShootDeps): Promise<string[]> {
  const folders: string[] = [];
  for (const [index, scene] of plan.scenes.entries()) {
    const folder = deps.join(outDir, sceneFolder(index, scene.name));
    deps.log(`Scene ${index + 1}/${plan.scenes.length}: ${scene.name}`);
    for (const step of scene.prepare ?? []) await runStep(step, folder, deps);
    await deps.start(folder);
    let chatId: string | undefined;
    try {
      for (const step of scene.steps) chatId = (await runStep(step, folder, deps)) ?? chatId;
    } finally {
      await deps.stop(folder, chatId);
    }
    folders.push(folder);
  }
  return folders;
}

/**
 * Where takes and the cut go. An --out ending in .mp4 is the cut, with takes in a folder beside it
 * of the same name; a folder --out holds the takes (and walkthrough.mp4 with --assemble).
 */
export function shootTarget(
  out: string | undefined,
  assemble: boolean,
  resolve: (path: string) => string,
  now = Date.now(),
): { dir: string; mp4?: string } {
  if (out?.toLowerCase().endsWith(".mp4")) {
    const mp4 = resolve(out);
    return { dir: mp4.slice(0, -4), mp4 };
  }
  const dir = resolve(out ?? `shoot-${now}`);
  return assemble ? { dir, mp4: resolve(`${dir}/walkthrough.mp4`) } : { dir };
}

export const SHOOT_USAGE =
  "Usage: aeon record shoot <plan.json> [--out <dir-or-mp4>] [--assemble] [--browser <name>] [--no-mouse] [--fps 30] [--zoom] [--sound] [--max-idle <ms>] [--display :N]";
