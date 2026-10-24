import type { SiteRulesAnswer } from "@aeon/pi-adapter";

// What a chat's runs must stay off, answered to the extension once per cell. The block list
// itself lives in the extension's settings and is merged in there, so this only says:
//   only  — the sites the routine whose own run is executing may use;
//   allow — hosts the user typed themselves (their message, or a routine's instruction), which
//           lift a block for that run. Page content, attachments and agent-written text never do.

interface ActiveRoutineRun {
  only: string[];
  allow: string[];
}

const MAX_ACTIVE_RUNS = 4;
const MAX_ALLOW = 20;

export class BrowserSiteRules {
  private readonly prompts = new Map<string, string>();
  private readonly routineRuns = new Map<string, Map<string, ActiveRoutineRun>>();

  /** The message the user typed to start a run: the one place a named site lifts a block. */
  notePrompt(chatId: string, text: string): void {
    this.prompts.set(chatId, text.slice(0, 20_000));
    if (this.prompts.size > 200) {
      const oldest = this.prompts.keys().next().value;
      if (oldest !== undefined) this.prompts.delete(oldest);
    }
  }

  /**
   * A routine's own agent run is starting: its sites restrict this run, and the instruction the
   * user wrote is the text allowed to lift a block. The check value appended to the run's prompt
   * is page content, so it is never the source here.
   */
  beginRoutineRun(
    chatId: string,
    runId: string,
    instruction: string,
    sites: readonly string[],
  ): void {
    const runs = this.routineRuns.get(chatId) ?? new Map<string, ActiveRoutineRun>();
    runs.set(runId, { only: hostsOf(sites), allow: namedHosts(instruction) });
    // A run whose end was never seen must not restrict a chat forever.
    while (runs.size > MAX_ACTIVE_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
    this.routineRuns.set(chatId, runs);
  }

  /** The run ended (or the daemon lost it): the chat is back to the user's own messages. */
  endRoutineRun(chatId: string, runId: string): void {
    const runs = this.routineRuns.get(chatId);
    if (!runs) return;
    runs.delete(runId);
    if (!runs.size) this.routineRuns.delete(chatId);
  }

  answer(chatId: string): SiteRulesAnswer {
    const runs = [...(this.routineRuns.get(chatId)?.values() ?? [])];
    if (!runs.length)
      return { blocked: [], only: [], allow: namedHosts(this.prompts.get(chatId) ?? "") };
    return {
      blocked: [],
      only: unique(runs.flatMap((run) => run.only)),
      allow: unique(runs.flatMap((run) => run.allow)),
    };
  }
}

function hostsOf(sites: readonly string[]): string[] {
  return unique(sites.map(hostOf).filter((site): site is string => Boolean(site)));
}

/** Hosts the user wrote themselves: a URL, or a bare domain such as example.com. */
export function namedHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(
    /(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s"'<>()]*)?/gi,
  )) {
    const site = hostOf(match[0]);
    if (site && !site.endsWith(".local")) hosts.add(site);
    if (hosts.size >= MAX_ALLOW) break;
  }
  return [...hosts];
}

function hostOf(value: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
