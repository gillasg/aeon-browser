// Where a run's time went, from the chat's own timestamps: every gap between two entries is
// either the model thinking (it ends in an assistant entry) or a tool running (it ends in that
// tool's result), so the parts add up to the run's wall time. Read by reviews and evals to see
// what to cut: model turns, slow cells, blind sleeps, work done one site at a time.
interface SpeedBlock {
  type: string;
  text?: string;
}
interface SpeedEntry {
  timestamp: string;
  message: {
    role: string;
    content: SpeedBlock[];
    toolName?: string;
  } | null;
}

export interface SpeedReport {
  /** Model turns (assistant entries) and the seconds spent waiting for them. */
  turns: number;
  modelSeconds: number;
  /** Seconds each tool ran, by tool name. */
  toolSeconds: Record<string, number>;
  /** Seconds that blind sleeps would have wasted; they ended when the page settled. */
  sleepsCutSeconds: number;
  /** Speed tips the run was given: "serial" (sites one after another), "tiny" (tiny cells). */
  tips: string[];
}

const TIPS: [string, RegExp][] = [
  ["serial", /were worked one after another \(/],
  ["tiny", /the last 5 cells each did one quick step/],
];
const SLEEP = /\[sleep\] \d+ waits? ended (\d+(?:\.\d+)?) s early/g;

const round = (ms: number) => Math.round(ms / 100) / 10;

/** The report for the latest prompt's run (entries after the last user message). */
export function speedReport(entries: SpeedEntry[]): SpeedReport | undefined {
  const start = lastUserIndex(entries);
  if (start < 0) return undefined;
  const tally: Tally = { model: 0, turns: 0, sleeps: 0, tools: {}, tips: new Set() };
  let previous = Date.parse(entries[start]?.timestamp ?? "");
  for (const entry of entries.slice(start + 1)) {
    const at = Date.parse(entry.timestamp);
    const gap = Number.isFinite(at) && Number.isFinite(previous) ? Math.max(0, at - previous) : 0;
    if (Number.isFinite(at)) previous = at;
    count(tally, entry.message, gap);
  }
  if (!tally.turns) return undefined;
  return {
    turns: tally.turns,
    modelSeconds: round(tally.model),
    toolSeconds: Object.fromEntries(
      Object.entries(tally.tools).map(([name, ms]) => [name, round(ms)]),
    ),
    sleepsCutSeconds: round(tally.sleeps),
    tips: [...tally.tips],
  };
}

interface Tally {
  model: number;
  turns: number;
  sleeps: number;
  tools: Record<string, number>;
  tips: Set<string>;
}

/** Adds one entry's gap to the model or to its tool, and what its result text reports. */
function count(tally: Tally, message: SpeedEntry["message"], gap: number): void {
  if (message?.role === "assistant") {
    tally.model += gap;
    tally.turns++;
    return;
  }
  if (message?.role !== "tool") return;
  const name = message.toolName ?? "tool";
  tally.tools[name] = (tally.tools[name] ?? 0) + gap;
  const text = message.content.map((block) => block.text ?? "").join("\n");
  for (const match of text.matchAll(SLEEP)) tally.sleeps += Number(match[1]) * 1000;
  for (const [tip, pattern] of TIPS) if (pattern.test(text)) tally.tips.add(tip);
}

function lastUserIndex(entries: SpeedEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--)
    if (entries[index]?.message?.role === "user") return index;
  return -1;
}

/** "Time: model 315 s over 69 turns (4.6 s each) · browser_code 288 s · sleeps cut 40 s · tips: serial". */
export function speedLine(report: SpeedReport | undefined): string {
  if (!report) return "";
  const each = report.turns ? Math.round((report.modelSeconds / report.turns) * 10) / 10 : 0;
  const tools = Object.entries(report.toolSeconds)
    .sort((a, b) => b[1] - a[1])
    .map(([name, seconds]) => `${name} ${Math.round(seconds)} s`);
  return [
    `Time: model ${Math.round(report.modelSeconds)} s over ${report.turns} turns (${each} s each)`,
    ...tools,
    ...(report.sleepsCutSeconds >= 1
      ? [`sleeps cut ${Math.round(report.sleepsCutSeconds)} s`]
      : []),
    ...(report.tips.length ? [`tips: ${report.tips.join(", ")}`] : []),
  ].join(" · ");
}
