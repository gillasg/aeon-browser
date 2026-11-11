// When a chat run settles, save what it learned and emit one run card. A matching later prompt
// starts at rung 1: this process has no page host, so an exact route is handed over as a draft
// instead of being replayed. Replay itself lives in the engine and runs when a host is passed.

import type { ChatId, PiSessionEvent } from "@aeon/domain";
import type { RunCard } from "@aeon/protocol";
import {
  cancelPending,
  contentWords,
  listAbilities,
  listRoutes,
  matchSavedRoute,
  promoteRoute,
  settleRoutes,
  sitesNamed,
  stageRun,
  type ObservedStep,
  type RouteHit,
  type RunKnowledge,
} from "@browserkit/site-mapper";
import { draftBlock, fillRouteDraft } from "./route-draft.js";
import { declinesFor, previousDuration, rememberDuration } from "./route-memory.js";
import {
  absorb,
  flatSteps,
  openRun,
  seenFrom,
  type LiveRun,
  type SeenStep,
} from "./route-observe.js";
import { buildRunCard, type RunFacts } from "./run-card.js";

export interface RunCardHub {
  publish(chatId: ChatId, event: PiSessionEvent): unknown;
}

const SETTLE_MS = 3 * 60 * 1000;
const LONG_MS = 90_000;
const CORRECTION = /\b(wrong|incorrect|nope|instead)\b|\bnot that\b/i;
const MARKER = new Set(["wrong", "incorrect", "nope", "instead", "not", "that"]);

interface Prompted {
  user: string;
  submitted: string;
  fromMemory: boolean;
  draft: boolean;
  watcher: boolean;
}

interface Due {
  chatId: string;
  runId: string;
  task: string;
  fingerprint: string;
  prompt: string;
  steps: ObservedStep[];
}

export class RouteRecorder {
  private readonly prompted = new Map<string, Prompted>();
  private readonly runs = new Map<string, LiveRun>();
  private readonly lastSite = new Map<string, string>();
  private readonly due = new Map<string, Due[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly hub: RunCardHub,
    private readonly settleMs = SETTLE_MS,
  ) {}

  /** The user's words, plus a hidden `[draft]` block when a saved route matches. */
  async prepare(chatId: string, prompt: string): Promise<{ text: string; draft?: string }> {
    await this.noteCorrection(chatId, prompt).catch(report);
    const draft = await this.draftFor(chatId, prompt).catch(() => undefined);
    this.prompted.set(chatId, {
      user: prompt,
      submitted: prompt,
      fromMemory: false,
      draft: Boolean(draft),
      watcher: false,
    });
    return { text: prompt, ...(draft ? { draft } : {}) };
  }

  /** A routine run. Its own instruction is the prompt, and it can promote on this one success. */
  noteWatcher(chatId: string, prompt: string): void {
    if (this.runs.has(chatId)) return;
    const current = this.prompted.get(chatId);
    if (current && !current.watcher) return;
    this.prompted.set(chatId, {
      user: prompt,
      submitted: prompt,
      fromMemory: false,
      draft: false,
      watcher: true,
    });
  }

  /** The routine never started. Drop its prompt so the next thing the user types is not one. */
  dropIdlePrompt(chatId: string): void {
    if (this.runs.has(chatId)) return;
    if (this.prompted.get(chatId)?.watcher) this.prompted.delete(chatId);
  }

  observe(chatId: string, event: PiSessionEvent): Promise<void> {
    const seen = seenFrom(event);
    if (!seen) return Promise.resolve();
    const next = absorb(this.ensure(chatId, seen), seen, Date.now());
    if (!next.run) return Promise.resolve();
    if (!next.finish) {
      this.runs.set(chatId, next.run);
      return Promise.resolve();
    }
    this.runs.delete(chatId);
    return this.finish(next.run).catch(report);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private ensure(chatId: string, seen: { kind: string; state?: string }): LiveRun | undefined {
    const current = this.runs.get(chatId);
    if (current) return current;
    if (seen.kind === "user" || seen.kind === "error") return undefined;
    if (seen.kind === "run-state" && seen.state !== "running-unconfirmed") return undefined;
    const prompt = this.prompted.get(chatId);
    if (!prompt) return undefined;
    const run = openRun(
      chatId,
      `${chatId}:${Date.now()}`,
      prompt.user,
      prompt.submitted,
      Date.now(),
    );
    run.fromMemory = prompt.fromMemory;
    run.draft = prompt.draft;
    run.watcher = prompt.watcher;
    this.runs.set(chatId, run);
    return run;
  }

  private async draftFor(chatId: string, prompt: string): Promise<string | undefined> {
    const hit = await bestRoute(prompt, this.lastSite.get(chatId));
    if (!hit) return undefined;
    const draft = fillRouteDraft(
      {
        site: hit.route.site,
        summary: hit.route.summary,
        cell: hit.route.cell,
        lastOkAt: hit.route.lastOkAt,
      },
      1,
    );
    return draft ? draftBlock(draft) : undefined;
  }

  private async finish(run: LiveRun): Promise<void> {
    if (this.prompted.get(run.chatId)?.user === run.userPrompt) this.prompted.delete(run.chatId);
    const steps = flatSteps(run);
    const site = siteOf(steps);
    if (!site || !steps.length || run.ours) return;
    this.lastSite.set(run.chatId, site);
    const task = contentWords(run.userPrompt).join(" ") || "task";
    const durationMs = Math.max(0, Date.now() - run.startedAt);
    const previousMs = await previousDuration(site, task);
    await rememberDuration(site, task, durationMs);
    const staged = await this.stage(run, site, steps);
    const facts = await factsFor(run, site, task, durationMs, previousMs, staged?.id);
    const card = buildRunCard(facts);
    if (card) this.publish(run.chatId, card);
    if (staged && !run.corrected) this.arm(site, run, task, staged.fingerprint);
  }

  private async stage(
    run: LiveRun,
    site: string,
    steps: SeenStep[],
  ): Promise<{ id: string; fingerprint: string } | undefined> {
    const result = await stageRun({
      site,
      prompt: run.userPrompt,
      steps: steps.map(observedStep),
      corrected: run.corrected,
      watcher: run.watcher,
      knowledge: knowledgeOf(steps),
    });
    if (result.status !== "pending" || !result.route) return undefined;
    return { id: result.route.id, fingerprint: result.route.fingerprint };
  }

  private arm(site: string, run: LiveRun, task: string, fingerprint: string): void {
    const steps = flatSteps(run).map(observedStep);
    const list = this.due.get(site) ?? [];
    list.push({
      chatId: run.chatId,
      runId: run.runId,
      task,
      fingerprint,
      prompt: run.userPrompt,
      steps,
    });
    this.due.set(site, list);
    if (this.timers.has(site)) return;
    const timer = setTimeout(() => {
      this.timers.delete(site);
      void this.settle(site).catch(report);
    }, this.settleMs);
    timer.unref?.();
    this.timers.set(site, timer);
  }

  private async settle(site: string): Promise<void> {
    const due = this.due.get(site) ?? [];
    this.due.delete(site);
    const ready = await settleRoutes(site);
    const first = due[0];
    if (!first) return;
    let learned: RunFacts["learned"];
    for (const route of ready) {
      const promoted = await promoteRoute(route, {
        prompt: route.signature.join(" "),
        watcher: route.watcher === true,
      });
      if (promoted && !learned) learned = promoted.learned;
    }
    if (!learned) return;
    const card = buildRunCard({
      chatId: first.chatId,
      runId: first.runId,
      site,
      task: first.task,
      learned,
      declined: await declinesFor(site),
    });
    if (card) this.publish(first.chatId, card);
  }

  private async noteCorrection(chatId: string, prompt: string): Promise<void> {
    for (const [site, list] of [...this.due]) await this.skipWord(chatId, site, list, prompt);
  }

  private async skipWord(chatId: string, site: string, list: Due[], prompt: string): Promise<void> {
    const mine = list.filter(
      (item) => item.chatId === chatId && isWordCorrection(item.prompt, prompt),
    );
    if (!mine.length) return;
    for (const item of mine) await cancelPending(site, item.fingerprint);
    const dropped = new Set(mine.map((item) => item.fingerprint));
    const rest = list.filter((item) => item.chatId !== chatId || !dropped.has(item.fingerprint));
    this.keepDue(site, rest);
  }

  private keepDue(site: string, list: Due[]): void {
    if (list.length) {
      this.due.set(site, list);
      return;
    }
    this.due.delete(site);
    const timer = this.timers.get(site);
    if (timer) clearTimeout(timer);
    this.timers.delete(site);
  }

  private publish(chatId: string, card: RunCard): void {
    this.hub.publish(chatId as ChatId, { kind: "run-card", card });
  }
}

async function factsFor(
  run: LiveRun,
  site: string,
  task: string,
  durationMs: number,
  previousMs: number | undefined,
  fingerprint: string | undefined,
): Promise<RunFacts> {
  const fromMemory = run.fromMemory && !run.corrected;
  const drafted = run.draft && !run.corrected && !fromMemory;
  const unmapped = await unmappedSite(site);
  return {
    chatId: run.chatId,
    runId: run.runId,
    site,
    task,
    durationMs,
    ...(previousMs !== undefined ? { previousMs } : {}),
    path: pathOf(fromMemory, drafted, run.usedAbility),
    ...(run.partial ? { partial: run.partial } : {}),
    ...(fromMemory ? { fromMemory: true } : {}),
    ...(learnSite(unmapped, fromMemory, drafted, durationMs) ? { longFirstRun: true } : {}),
    ...(fingerprint ? { routeId: fingerprint } : {}),
    declined: await declinesFor(site),
    ...(run.ours ? { ours: true } : {}),
  };
}

function learnSite(
  unmapped: boolean,
  fromMemory: boolean,
  drafted: boolean,
  durationMs: number,
): boolean {
  return unmapped && !fromMemory && !drafted && durationMs >= LONG_MS;
}

function pathOf(
  fromMemory: boolean,
  draft: boolean,
  usedAbility: boolean,
): "from memory" | "with a saved draft" | "saved ability" | "first time" {
  if (fromMemory) return "from memory";
  if (draft) return "with a saved draft";
  return usedAbility ? "saved ability" : "first time";
}

/** A short follow-up that only rejects the last run. A new site or target is a new task. */
export function isWordCorrection(priorPrompt: string, nextPrompt: string): boolean {
  if (!CORRECTION.test(nextPrompt)) return false;
  const words = nextPrompt.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length >= 8) return false;
  if (hasNewSite(priorPrompt, nextPrompt)) return false;
  return newTargets(priorPrompt, nextPrompt).length === 0;
}

function hasNewSite(prior: string, next: string): boolean {
  const known = new Set(sitesNamed(prior));
  return sitesNamed(next).some((site) => !known.has(site));
}

function newTargets(prior: string, next: string): string[] {
  const known = new Set(contentWords(prior));
  return contentWords(next).filter((word) => !known.has(word) && !MARKER.has(word));
}

async function unmappedSite(site: string): Promise<boolean> {
  try {
    return (await listAbilities(site)).length === 0;
  } catch {
    return false;
  }
}

async function bestRoute(prompt: string, hint: string | undefined): Promise<RouteHit | undefined> {
  const named = sitesNamed(prompt);
  const sites = named.length ? named : hint ? [hint] : [];
  let best: RouteHit | undefined;
  for (const site of sites) {
    const hit = matchSavedRoute(prompt, await listRoutes(site).catch(() => []));
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

function siteOf(steps: readonly SeenStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (!step.site) continue;
    counts.set(step.site, (counts.get(step.site) ?? 0) + 1);
  }
  let best = "";
  let count = 0;
  for (const [site, seen] of counts)
    if (seen > count) {
      best = site;
      count = seen;
    }
  return best;
}

function observedStep(step: SeenStep): ObservedStep {
  return {
    id: step.id,
    kind: step.kind,
    ...(step.target ? { target: step.target } : {}),
    ...(step.effect ? { effect: step.effect } : {}),
    write: step.write,
    ...(step.sensitive ? { sensitive: true } : {}),
    pageType: pageType(step.url),
    ...(step.url ? { url: step.url } : {}),
    ...(step.evidence ? { evidence: step.evidence } : {}),
  };
}

function knowledgeOf(steps: readonly SeenStep[]): RunKnowledge {
  return {
    pages: steps.flatMap((step) =>
      step.url
        ? [
            {
              url: step.url,
              landmarks: [],
              headings: [],
              controls: step.target?.name ? [step.target.name] : [],
            },
          ]
        : [],
    ),
    controls: steps.flatMap((step) => (step.target ? [step.target] : [])),
  };
}

function pageType(url: string | undefined): string {
  if (!url) return "page";
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0]?.slice(0, 40) || "page";
  } catch {
    return "page";
  }
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`route: ${message}\n`);
}
